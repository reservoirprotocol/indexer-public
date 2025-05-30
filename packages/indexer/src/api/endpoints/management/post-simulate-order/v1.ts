import { parseEther } from "@ethersproject/units";
import { CallTrace } from "@georgeroman/evm-tx-simulator/dist/types";
import Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import { Network } from "@reservoir0x/sdk/dist/utils";
import axios from "axios";
import Joi from "joi";

import { inject } from "@/api/index";
import { idb, redb } from "@/common/db";
import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";
import { redis } from "@/common/redis";
import { bn, fromBuffer, now, regex, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import { getNetworkSettings } from "@/config/network";
import { Sources } from "@/models/sources";
import * as b from "@/utils/auth/blur";
import { getUSDAndNativePrices } from "@/utils/prices";
import {
  genericTaker,
  ensureBuyTxSucceeds,
  ensureSellTxSucceeds,
  customTaker,
} from "@/utils/simulation";
import { ApiKeyManager } from "@/models/api-keys";
import _ from "lodash";

const version = "v1";

export const postSimulateOrderV1Options: RouteOptions = {
  description: "Simulate any given order",
  tags: ["api", "Management", "marketplace"],
  plugins: {
    "hapi-swagger": {
      order: 13,
    },
  },
  timeout: {
    server: 2 * 60 * 1000,
  },
  validate: {
    payload: Joi.object({
      id: Joi.string().lowercase(),
      token: Joi.string().pattern(regex.token).lowercase(),
      collection: Joi.string().lowercase(),
      skipRevalidation: Joi.boolean().default(false),
      includeCalldata: Joi.boolean()
        .default(false)
        .description("Requires an authorized api key to be passed."),
    }).xor("token", "collection", "id"),
  },
  response: {
    schema: Joi.object({
      message: Joi.string(),
      callData: Joi.any(),
    }).label(`postSimulateOrder${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`post-simulate-order-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    logger.debug(
      `post-simulate-order-${version}-handler`,
      JSON.stringify({
        topic: "debugSimulation",
        message: "Start",
        payload: request.payload,
      })
    );

    if (
      ![
        Network.Ethereum,
        Network.EthereumGoerli,
        Network.EthereumSepolia,
        Network.Polygon,
        Network.Mumbai,
        Network.Amoy,
        Network.Arbitrum,
        Network.ArbitrumNova,
        Network.Optimism,
        Network.Base,
        Network.Zora,
        Network.Blast,
        Network.Apex,
        Network.Apechain,
        Network.Sei,
        Network.Abstract,
        Network.AbstractTestnet,
        Network.Berachain,
      ].includes(config.chainId)
    ) {
      return { message: "Simulation not supported" };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = request.payload as any;

    const logAndRevalidateOrder = async (
      id: string,
      status: "active" | "inactive",
      options?: {
        callTrace?: CallTrace;
        payload?: object;
        revalidate?: boolean;
        createdTime?: number;
        tokenSetId?: string;
        side?: string;
      }
    ) => {
      if (!payload.skipRevalidation && options?.revalidate) {
        logger.warn(
          `post-revalidate-order-${version}-handler`,
          JSON.stringify({
            error: "stale-order",
            callTrace: options?.callTrace,
            block: await baseProvider.getBlock("latest").then((b) => b.number),
            payload: options?.payload,
            orderId: id,
            status,
          })
        );

        if (status === "inactive" && options.createdTime && options.createdTime <= now() - 60) {
          logger.warn(
            `post-revalidate-order-${version}-handler`,
            JSON.stringify({
              msg: "Order invalidated right after creation",
              callTrace: options?.callTrace,
              block: await baseProvider.getBlock("latest").then((b) => b.number),
              payload: options?.payload,
              orderId: id,
              tokenSetId: options?.tokenSetId,
              side: options?.side,
            })
          );
        }

        // Revalidate the order
        await inject({
          method: "POST",
          url: `/admin/revalidate-order`,
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Api-Key": config.adminApiKey,
          },
          payload: {
            id,
            status,
          },
        });
      }
    };

    try {
      let id = payload.id;

      let includeCalldata = false;

      const apiKey = await ApiKeyManager.getApiKey(request.headers["x-api-key"]);

      if (payload.includeCalldata) {
        if (_.isNull(apiKey)) {
          throw Boom.unauthorized("Invalid API key");
        }

        if (!apiKey.permissions?.retrieve_simulate_order_call_data) {
          throw Boom.unauthorized("Not allowed");
        }

        includeCalldata = true;
      }

      // Lookup the floor-ask order by token
      const token = payload.token;
      if (token) {
        const [contract, tokenId] = payload.token.split(":");
        const result = await idb.oneOrNone(
          `
            SELECT
              tokens.floor_sell_id
            FROM tokens
            WHERE tokens.contract = $/contract/
              AND tokens.token_id = $/tokenId/
            LIMIT 1
          `,
          {
            contract: toBuffer(contract),
            tokenId,
          }
        );
        if (result && result.floor_sell_id) {
          id = result.floor_sell_id;
        }
      }

      // Lookup the floor-ask order by collection
      const collection = payload.collection;
      if (collection) {
        const result = await idb.oneOrNone(
          `
            SELECT
              collections.floor_sell_id
            FROM collections
            WHERE collections.id = $/collection/
            LIMIT 1
          `,
          {
            collection,
          }
        );
        if (result && result.floor_sell_id) {
          id = result.floor_sell_id;
        }
      }

      if (!id) {
        throw Boom.badRequest("No corresponding order was found");
      }

      const orderResult = await idb.oneOrNone(
        `
          SELECT
            orders.kind,
            orders.side,
            orders.currency,
            orders.currency_price,
            orders.contract,
            orders.token_set_id,
            orders.fillability_status,
            orders.approval_status,
            orders.source_id_int,
            orders.conduit,
            orders.raw_data,
            floor(extract(epoch FROM orders.created_at)) AS created_at
          FROM orders
          WHERE orders.id = $/id/
        `,
        { id }
      );
      if (!orderResult?.side || !orderResult?.contract) {
        throw Boom.badRequest("Could not find order");
      }

      // Custom logic for simulating Blur listings
      if (orderResult.side === "sell" && orderResult.kind === "blur") {
        const [, contract, tokenId] = orderResult.token_set_id.split(":");

        const blurPrice = await axios
          .get(
            `${config.orderFetcherBaseUrl}/api/blur-token?contract=${contract}&tokenId=${tokenId}&chainId=${config.chainId}`
          )
          .then((response) =>
            response.data.blurPrice
              ? parseEther(response.data.blurPrice).toString()
              : response.data.blurPrice
          );
        if (orderResult.currency_price !== blurPrice) {
          await logAndRevalidateOrder(id, "inactive", {
            revalidate: true,
          });
        }
      }

      const currency = fromBuffer(orderResult.currency);
      if (currency !== Sdk.Common.Addresses.Native[config.chainId]) {
        try {
          const prices = await getUSDAndNativePrices(currency, orderResult.currency_price, now(), {
            onlyUSD: true,
          });
          // Simulations for listings with a price >= $100k might fail due to insufficient liquidity
          if (prices.usdPrice && bn(prices.usdPrice).gte(100000000000)) {
            return { message: "Price too high to simulate" };
          }
        } catch {
          // Skip errors
        }
      }
      if (
        ["nftx", "nftx-v3", "sudoswap", "sudoswap-v2", "payment-processor", "zora-v4"].includes(
          orderResult.kind
        )
      ) {
        return { message: "Order not simulatable" };
      }
      if (orderResult.kind === "blur" && orderResult.side === "buy") {
        return { message: "Order not simulatable" };
      }
      if (getNetworkSettings().whitelistedCurrencies.has(currency)) {
        return { message: "Order not simulatable" };
      }
      if (getNetworkSettings().nonSimulatableContracts.includes(fromBuffer(orderResult.contract))) {
        return { message: "Associated contract is not simulatable" };
      }

      const hasStakingKeywords = await redis.get(
        `has-staking-keywords:${fromBuffer(orderResult.contract)}`
      );

      const contract = fromBuffer(orderResult.contract);

      // Sell-side skipping
      {
        const skipCombinations = ["0x7d6bcd4ba3beffef0d46a52ebc68a3e4eb081d39:1"];
        if (
          orderResult.side === "sell" &&
          skipCombinations.includes(`${contract}:${config.chainId}`)
        ) {
          return {
            message: "Order not simulatable due to custom contract logic",
          };
        }
      }

      // Buy-side skipping
      {
        const skipCombinations = [
          // ENS
          "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85:1",
          "0x7d6bcd4ba3beffef0d46a52ebc68a3e4eb081d39:1",
          "0x23581767a106ae21c074b2276d25e5c3e136a68b:1",
          "0x8f1b132e9fd2b9a2b210baa186bf1ae650adf7ac:1",
          "0xd4b7d9bb20fa20ddada9ecef8a7355ca983cccb1:1",
          "0x5946aeaab44e65eb370ffaa6a7ef2218cff9b47d:1",
          "0xeb2dfc54ebafca8f50efcc1e21a9d100b5aeb349:1",
          "0xc589770757cd0d372c54568bf7e5e1d56b958015:1",
          "0x99f419934192f8de7bf53b490d5bdb88527654bf:1",
          "0x2187093a2736442d0b5c5d5464b98fc703e3b88d:1",
          "0x39ee2c7b3cb80254225884ca001f57118c8f21b6:1",
          "0xc379e535caff250a01caa6c3724ed1359fe5c29b:1",
          "0xf6228c82fc2404d90827d9d7a1340106a3407b06:1",
          "0x670fd103b1a08628e9557cd66b87ded841115190:137",
          "0x990086af37aff0c3641d2a7675fc558e68427f2d:81457",
        ];
        if (
          orderResult.side === "buy" &&
          (hasStakingKeywords || skipCombinations.includes(`${contract}:${config.chainId}`))
        ) {
          return {
            message: "Order not simulatable due to custom contract logic",
          };
        }
      }
      if (orderResult.raw_data?.permitId) {
        return { message: "Order not simulatable" };
      }

      const contractResult = await redb.one(
        `
          SELECT
            contracts.kind
          FROM contracts
          WHERE contracts.address = $/contract/
        `,
        { contract: orderResult.contract }
      );
      if (!["erc721", "erc1155"].includes(contractResult.kind)) {
        return { message: "Non-standard contracts not supported" };
      }

      if (orderResult.side === "sell") {
        let taker = genericTaker;
        let skipBalanceCheck = true;

        // Ensure a Blur auth is available
        if (orderResult.kind === "blur") {
          const customTakerWallet = customTaker();

          // Override some request fields
          taker = customTakerWallet.address.toLowerCase();
          skipBalanceCheck = false;

          const blurAuthChallengeId = b.getAuthChallengeId(taker);

          let blurAuthChallenge = await b.getAuthChallenge(blurAuthChallengeId);
          if (!blurAuthChallenge) {
            blurAuthChallenge = (await axios
              .get(
                `${config.orderFetcherBaseUrl}/api/blur-auth-challenge?taker=${taker}&chainId=${config.chainId}`
              )
              .then((response) => response.data.authChallenge)) as b.AuthChallenge;

            await b.saveAuthChallenge(blurAuthChallengeId, blurAuthChallenge, 60);

            await inject({
              method: "POST",
              url: `/execute/auth-signature/v1?signature=${await customTakerWallet.signMessage(
                blurAuthChallenge.message
              )}`,
              headers: {
                "Content-Type": "application/json",
              },
              payload: {
                kind: "blur",
                id: blurAuthChallengeId,
              },
            });
          }
        }

        const response = await inject({
          method: "POST",
          url: "/execute/buy/v7",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Api-Key": config.adminApiKey,
          },
          payload: {
            items: [{ orderId: id }],
            taker,
            skipBalanceCheck,
            currency: Sdk.Common.Addresses.Native[config.chainId],
            allowInactiveOrderIds: true,
            skipOffChainCancellableIsFillableCheck: payload.includeCalldata,
          },
        });

        if (response.statusCode !== 200) {
          logger.info(
            "debug",
            JSON.stringify({
              payload: {
                items: [{ orderId: id }],
                taker,
                skipBalanceCheck,
                currency: Sdk.Common.Addresses.Native[config.chainId],
                allowInactiveOrderIds: true,
                skipOffChainCancellableIsFillableCheck: payload.includeCalldata,
              },
              response: response.payload,
              status: response.statusCode,
            })
          );

          return { message: "Simulation failed" };
        }

        if (response.payload.includes("No available orders")) {
          return { message: "No orders to simulate" };
        }

        const parsedPayload = JSON.parse(response.payload);
        if (!parsedPayload?.path?.length) {
          return {
            message: "Nothing to simulate",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        }

        const numIncompleteItems = (parsedPayload.steps as { items: { status: string }[] }[])
          .map((s) => s.items.filter((i) => i.status === "incomplete").length)
          .reduce((a, b) => a + b, 0);
        if (numIncompleteItems > 1) {
          return {
            message: "Order not simulatable due to multiple required transactions",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        }

        const saleData = parsedPayload.steps.find((s: { id: string }) => s.id === "sale").items[0]
          ?.data;
        if (!saleData) {
          return {
            message: "Nothing to simulate",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        }

        const pathItem = parsedPayload.path[0];

        const { result: success, callTrace } = await ensureBuyTxSucceeds(
          taker,
          {
            kind: contractResult.kind as "erc721" | "erc1155",
            contract: pathItem.contract as string,
            tokenId: pathItem.tokenId as string,
            amount: pathItem.quantity as string,
          },
          saleData
        );
        if (success) {
          // active -> inactive
          const needRevalidation =
            orderResult.fillability_status !== "fillable" ||
            orderResult.approval_status !== "approved";
          await logAndRevalidateOrder(id, "active", {
            callTrace,
            payload: parsedPayload,
            revalidate: needRevalidation,
          });

          return {
            message: "Order is fillable",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        } else {
          // inactive -> active
          const needRevalidation =
            orderResult.fillability_status === "fillable" &&
            orderResult.approval_status === "approved";
          await logAndRevalidateOrder(id, "inactive", {
            callTrace,
            payload: parsedPayload,
            revalidate: needRevalidation,
            createdTime: orderResult.created_at,
            tokenSetId: orderResult.token_set_id,
            side: orderResult.side,
          });

          return {
            message: "Order is not fillable",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        }
      } else {
        const sources = await Sources.getInstance();
        const tokenResult = await idb.oneOrNone(
          `
            SELECT
              nft_balances.owner,
              tokens.contract,
              tokens.token_id
            FROM tokens
            JOIN token_sets_tokens
              ON token_sets_tokens.contract = tokens.contract
              AND token_sets_tokens.token_id = tokens.token_id
            JOIN nft_balances
              ON nft_balances.contract = tokens.contract
              AND nft_balances.token_id = tokens.token_id
            WHERE token_sets_tokens.token_set_id = $/tokenSetId/
              AND nft_balances.amount > 0
              ${
                sources.get(orderResult.source_id_int)?.domain === "opensea.io"
                  ? `
                    AND (tokens.is_flagged IS NULL OR tokens.is_flagged = 0)
                    AND nft_balances.acquired_at < now() - interval '3 hours'
                  `
                  : ""
              }
              AND (
                SELECT
                  approved
                FROM nft_approval_events
                WHERE nft_approval_events.address = $/contract/
                  AND nft_approval_events.owner = nft_balances.owner
                  AND nft_approval_events.operator = $/conduit/
                ORDER BY nft_approval_events.block DESC
                LIMIT 1
              )
            ORDER BY tokens.created_at DESC
            LIMIT 1
          `,
          {
            tokenSetId: orderResult.token_set_id,
            contract: orderResult.contract,
            conduit: orderResult.conduit,
          }
        );
        if (!tokenResult) {
          throw Boom.badRequest("Could not simulate order");
        }

        const owner = fromBuffer(tokenResult.owner);

        const response = await inject({
          method: "POST",
          url: "/execute/sell/v7",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Api-Key": config.adminApiKey,
          },
          payload: {
            items: [
              {
                token: `${fromBuffer(tokenResult.contract)}:${tokenResult.token_id}`,
                orderId: id,
              },
            ],
            taker: owner,
            allowInactiveOrderIds: true,
            skipOffChainCancellableIsFillableCheck: payload.includeCalldata,
          },
        });

        if (response.statusCode !== 200) {
          logger.info(
            "debug",
            JSON.stringify({
              payload: {
                items: [{ orderId: id }],
                currency: Sdk.Common.Addresses.Native[config.chainId],
                allowInactiveOrderIds: true,
                skipOffChainCancellableIsFillableCheck: payload.includeCalldata,
              },
              response: response.payload,
              status: response.statusCode,
            })
          );

          return { message: "Simulation failed" };
        }

        if (response.payload.includes("No available orders")) {
          return { message: "No orders to simulate" };
        }

        const parsedPayload = JSON.parse(response.payload);
        if (!parsedPayload?.path?.length) {
          return {
            message: "Nothing to simulate",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        }

        const numIncompleteItems = (parsedPayload.steps as { items: { status: string }[] }[])
          .map((s) => s.items.filter((i) => i.status === "incomplete").length)
          .reduce((a, b) => a + b, 0);
        if (numIncompleteItems > 1) {
          return {
            message: "Order not simulatable due to multiple required transactions",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        }

        const saleData = parsedPayload.steps.find((s: { id: string }) => s.id === "sale").items[0]
          ?.data;
        if (!saleData) {
          return {
            message: "Nothing to simulate",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        }

        const pathItem = parsedPayload.path[0];

        const { result: success, callTrace } = await ensureSellTxSucceeds(
          owner,
          {
            kind: contractResult.kind as "erc721" | "erc1155",
            contract: pathItem.contract as string,
            tokenId: pathItem.tokenId as string,
            amount: pathItem.quantity as string,
          },
          saleData
        );
        if (success) {
          // active -> inactive
          const needRevalidation =
            orderResult.fillability_status !== "fillable" ||
            orderResult.approval_status !== "approved";
          await logAndRevalidateOrder(id, "active", {
            callTrace,
            payload: parsedPayload,
            revalidate: needRevalidation,
          });

          return {
            message: "Order is fillable",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        } else {
          // inactive -> active
          const needRevalidation =
            orderResult.fillability_status === "fillable" &&
            orderResult.approval_status === "approved";
          await logAndRevalidateOrder(id, "inactive", {
            callTrace,
            payload: parsedPayload,
            revalidate: needRevalidation,
            createdTime: orderResult.created_at,
            tokenSetId: orderResult.token_set_id,
          });

          return {
            message: "Order is not fillable",
            callData: includeCalldata ? parsedPayload : undefined,
          };
        }
      }
    } catch (error) {
      if (!(error instanceof Boom.Boom)) {
        logger.error(`post-simulate-order-${version}-handler`, `Handler failure: ${error}`);
      }

      throw error;
    }
  },
};
