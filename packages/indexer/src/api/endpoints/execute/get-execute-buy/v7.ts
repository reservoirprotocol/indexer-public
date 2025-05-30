/* eslint-disable @typescript-eslint/no-explicit-any */

import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { keccak256 } from "@ethersproject/solidity";
import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import { PermitHandler } from "@reservoir0x/sdk/dist/router/v6/permit";
import {
  FillListingsResult,
  ListingDetails,
  MintDetails,
} from "@reservoir0x/sdk/dist/router/v6/types";
import { estimateGasFromTxTags, initializeTxTags } from "@reservoir0x/sdk/dist/router/v6/utils";
import axios from "axios";
import { randomUUID } from "crypto";
import Joi from "joi";
import _ from "lodash";

import { inject } from "@/api/index";
import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { JoiExecuteFee, JoiPrice, getJoiPriceObject } from "@/common/joi";
import { baseProvider, getGasFee } from "@/common/provider";
import { bn, formatPrice, fromBuffer, now, regex, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import { ApiKeyManager } from "@/models/api-keys";
import { FeeRecipients } from "@/models/fee-recipients";
import { Sources } from "@/models/sources";
import * as mints from "@/orderbook/mints";
import {
  PartialCollectionMint,
  generateCollectionMintTxData,
  normalizePartialCollectionMint,
} from "@/orderbook/mints/calldata";
import { getNFTTransferEvents } from "@/orderbook/mints/simulation";
import { OrderKind, generateListingDetailsV6 } from "@/orderbook/orders";
import { fillErrorCallback, getExecuteError } from "@/orderbook/orders/errors";
import * as commonHelpers from "@/orderbook/orders/common/helpers";
import * as nftx from "@/orderbook/orders/nftx";
import { getConduitKeyWithDefault } from "@/orderbook/orders/seaport-v1.5/build/utils";
import * as sudoswap from "@/orderbook/orders/sudoswap";
import * as b from "@/utils/auth/blur";
import * as e from "@/utils/auth/erc721c";
import { getCurrency } from "@/utils/currencies";
import * as erc721c from "@/utils/erc721c";
import { ExecutionsBuffer } from "@/utils/executions";
import { checkAddressIsBlockedByOFAC } from "@/utils/ofac";
import * as onChainData from "@/utils/on-chain-data";
import { getEphemeralPermitId, getEphemeralPermit, saveEphemeralPermit } from "@/utils/permits";
import { getPreSignatureId, getPreSignature, savePreSignature } from "@/utils/pre-signatures";
import { getUSDAndCurrencyPrices, validateSwapPrice } from "@/utils/prices";
import { isOrderNativeOffChainCancellable } from "@/utils/offchain-cancel";
import { getOpenseaChainName } from "@/config/network";

const version = "v7";

export const getExecuteBuyV7Options: RouteOptions = {
  description: "Buy Tokens",
  notes:
    "Use this API to fill listings. We recommend using the SDK over this API as the SDK will iterate through the steps and return callbacks. Please mark `excludeEOA` as `true` to exclude Blur orders.",
  tags: ["api", "marketplace"],
  timeout: {
    server: 40 * 1000,
  },
  plugins: {
    "hapi-swagger": {
      order: 10,
    },
  },
  validate: {
    payload: Joi.object({
      items: Joi.array()
        .items(
          Joi.object({
            collection: Joi.string().lowercase().description("Collection to buy."),
            token: Joi.string().lowercase().pattern(regex.token).description("Token to buy."),
            quantity: Joi.number().integer().positive().description("Quantity of tokens to buy."),
            orderId: Joi.string().lowercase().description("Optional order id to fill."),
            rawOrder: Joi.object({
              kind: Joi.string()
                .lowercase()
                .valid(
                  "opensea",
                  "blur-partial",
                  "looks-rare",
                  "zeroex-v4",
                  "seaport",
                  "seaport-v1.4",
                  "seaport-v1.5",
                  "seaport-v1.6",
                  "mintify",
                  "x2y2",
                  "rarible",
                  "sudoswap",
                  "nftx",
                  "alienswap",
                  "mint"
                ),
              data: Joi.object(),
            }).description("Optional raw order to fill."),
            fillType: Joi.string()
              .valid("trade", "mint", "preferMint")
              .default("preferMint")
              .description(
                "Specify preferred fillType. `preferMint`: First, tries to mint a new NFT if available; otherwise, it purchases from the secondary market. `trade`: Always buys from the secondary market, regardless of price. `mint`: Always mints a new NFT."
              ),
            preferredMintStage: Joi.string()
              .optional()
              .description("Optionally specify a stage to mint"),
            preferredOrderSource: Joi.string()
              .lowercase()
              .pattern(regex.domain)
              .when("token", { is: Joi.exist(), then: Joi.allow(), otherwise: Joi.forbidden() })
              .description(
                "If there are multiple listings with equal best price, prefer this source over others.\nNOTE: if you want to fill a listing that is not the best priced, you need to pass a specific order id or use `exactOrderSource`."
              ),
            exactOrderSource: Joi.alternatives()
              .try(
                Joi.array().max(2).items(Joi.string().lowercase().pattern(regex.domain)),
                Joi.string().lowercase().pattern(regex.domain)
              )
              .when("token", { is: Joi.exist(), then: Joi.allow(), otherwise: Joi.forbidden() })
              .description("Only consider orders from this source."),
            exclusions: Joi.array()
              .items(
                Joi.object({
                  orderId: Joi.string().required(),
                  price: Joi.string().pattern(regex.number),
                })
              )
              .description("Items to exclude"),
          })
            .oxor("token", "collection", "orderId", "rawOrder")
            .or("token", "collection", "orderId", "rawOrder")
            .oxor("preferredOrderSource", "exactOrderSource")
        )
        .min(1)
        .required()
        .description("List of items to buy."),
      taker: Joi.string()
        .lowercase()
        .pattern(regex.address)
        .required()
        .description("Address of wallet filling (receiver of the NFT)."),
      relayer: Joi.string()
        .lowercase()
        .pattern(regex.address)
        .description("Address of wallet relaying the fill transaction (paying for the NFT)."),
      onlyPath: Joi.boolean()
        .default(false)
        .description("If true, only the path will be returned."),
      forceRouter: Joi.boolean().description(
        "If true, all fills will be executed through the router (where possible)"
      ),
      forwarderChannel: Joi.string()
        .lowercase()
        .pattern(regex.address)
        .description(
          "If passed, all fills will be executed through the trusted trusted forwarder (where possible)"
        )
        .optional(),
      currency: Joi.string().lowercase().description("Currency to be used for purchases."),
      normalizeRoyalties: Joi.boolean().default(false).description("Charge any missing royalties."),
      allowInactiveOrderIds: Joi.boolean()
        .default(false)
        .description(
          "If true, inactive orders will not be skipped over (only relevant when filling via a specific order id)."
        ),
      source: Joi.string()
        .lowercase()
        .pattern(regex.domain)
        .description("Filling source used for attribution. Example: `reservoir.market`"),
      feesOnTop: Joi.array()
        .items(Joi.string().pattern(regex.fee))
        .description(
          "List of fees (formatted as `feeRecipient:feeAmount`) to be taken when filling.\nUnless overridden via the `currency` param, the currency used for any fees on top matches the buy-in currency detected by the backend.\nExample: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00:1000000000000000`"
        ),
      partial: Joi.boolean()
        .default(false)
        .description("If true, any off-chain or on-chain errors will be skipped."),
      skipBalanceCheck: Joi.boolean()
        .default(false)
        .description("If true, balance check will be skipped."),
      excludeEOA: Joi.boolean()
        .default(false)
        .description(
          "Exclude orders that can only be filled by EOAs, to support filling with smart contracts. If marked `true`, blur will be excluded."
        ),
      maxFeePerGas: Joi.string()
        .pattern(regex.number)
        .description(
          "Optional custom gas settings. Includes base fee & priority fee in this limit."
        ),
      maxPriorityFeePerGas: Joi.string()
        .pattern(regex.number)
        .description("Optional custom gas settings."),
      usePermit: Joi.boolean().description("When true, will use permit to avoid approvals."),
      swapProvider: Joi.string()
        .valid("uniswap", "relay")
        .default("uniswap")
        .description(
          "Choose a specific swapping provider when buying in a different currency (defaults to `relay`)"
        ),
      referrer: Joi.string()
        .pattern(regex.address)
        .optional()
        .description("Referrer address (where supported)"),
      comment: Joi.string().optional().description("Mint comment (where suported)"),
      conduitKey: Joi.string()
        .lowercase()
        .optional()
        .pattern(regex.bytes32)
        .description("Conduit key to use to fulfill the order"),
      // Various authorization keys
      x2y2ApiKey: Joi.string().description("Optional X2Y2 API key used for filling."),
      openseaApiKey: Joi.string().description(
        "Optional OpenSea API key used for filling. You don't need to pass your own key, but if you don't, you are more likely to be rate-limited."
      ),
      blurAuth: Joi.string().description(
        "Advanced use case to pass personal blurAuthToken; the API will generate one if left empty."
      ),
    }).unknown(true),
  },
  response: {
    schema: Joi.object({
      requestId: Joi.string(),
      steps: Joi.array().items(
        Joi.object({
          id: Joi.string().required(),
          action: Joi.string().required(),
          description: Joi.string().required(),
          kind: Joi.string().valid("signature", "transaction").required(),
          items: Joi.array()
            .items(
              Joi.object({
                status: Joi.string()
                  .valid("complete", "incomplete")
                  .required()
                  .description("Response is `complete` or `incomplete`."),
                tip: Joi.string(),
                orderIds: Joi.array().items(Joi.string()),
                data: Joi.object(),
                check: Joi.object({
                  endpoint: Joi.string().required(),
                  method: Joi.string().valid("POST").required(),
                  body: Joi.any(),
                }).description("The details of the endpoint for checking the status of the step"),
                // TODO: To remove, only kept for backwards-compatibility
                gasEstimate: Joi.number().description(
                  "Approximation of gas used (only applies to `transaction` items)"
                ),
              })
            )
            .required(),
        })
      ),
      errors: Joi.array().items(
        Joi.object({
          message: Joi.string(),
          orderId: Joi.string(),
        })
      ),
      path: Joi.array().items(
        Joi.object({
          orderId: Joi.string(),
          contract: Joi.string().lowercase().pattern(regex.address),
          tokenId: Joi.string().lowercase().pattern(regex.number),
          quantity: Joi.number().unsafe(),
          source: Joi.string().allow("", null),
          currency: Joi.string().lowercase().pattern(regex.address),
          currencySymbol: Joi.string().optional().allow(null),
          currencyDecimals: Joi.number().optional().allow(null),
          quote: Joi.number().unsafe(),
          rawQuote: Joi.string().pattern(regex.number),
          buyInCurrency: Joi.string().lowercase().pattern(regex.address),
          buyInCurrencySymbol: Joi.string().optional().allow(null),
          buyInCurrencyDecimals: Joi.number().optional().allow(null),
          buyInQuote: Joi.number().unsafe(),
          buyInRawQuote: Joi.string().pattern(regex.number),
          totalPrice: Joi.number().unsafe(),
          totalRawPrice: Joi.string().pattern(regex.number),
          builtInFees: Joi.array()
            .items(JoiExecuteFee)
            .description("Can be marketplace fees or royalties"),
          feesOnTop: Joi.array().items(JoiExecuteFee).description("Can be referral fees."),
          // TODO: Remove, only kept for backwards-compatibility reasons
          gasCost: Joi.string().pattern(regex.number),
          isNativeOffChainCancellable: Joi.boolean().allow(null),
        })
      ),
      maxQuantities: Joi.array().items(
        Joi.object({
          itemIndex: Joi.number().required(),
          maxQuantity: Joi.string().pattern(regex.number).allow(null),
        })
      ),
      fees: Joi.object({
        gas: JoiPrice,
        relayer: JoiPrice,
      }),
      // TODO: To remove, only kept for backwards-compatibility reasons
      gasEstimate: Joi.number(),
    }).label(`getExecuteBuy${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-execute-buy-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = request.payload as any;

    try {
      type ExecuteFee = {
        kind?: string;
        recipient: string;
        bps?: number;
        amount: number;
        rawAmount: string;
      };

      // Keep track of the listings and path to fill
      const listingDetails: ListingDetails[] = [];
      let path: {
        orderId: string;
        contract: string;
        tokenId?: string;
        quantity: number;
        source: string | null;
        currency: string;
        currencySymbol?: string;
        currencyDecimals?: number;
        // Gross price (without fees on top) = price
        quote: number;
        rawQuote: string;
        buyInCurrency?: string;
        buyInCurrencySymbol?: string;
        buyInCurrencyDecimals?: number;
        buyInQuote?: number;
        buyInRawQuote?: string;
        // Total price (with fees on top) = price + feesOnTop
        totalPrice?: number;
        totalRawPrice?: string;
        builtInFees: ExecuteFee[];
        feesOnTop: ExecuteFee[];
        // TODO: To remove, only kept for backwards-compatibility reasons
        gasCost?: string;
        isNativeOffChainCancellable: boolean | null;
      }[] = [];

      const key = request.headers["x-api-key"];
      const apiKey = await ApiKeyManager.getApiKey(key);

      // Source restrictions
      if (payload.source) {
        const sources = await Sources.getInstance();
        const sourceObject = sources.getByDomain(payload.source);
        if (sourceObject && sourceObject.metadata?.allowedApiKeys?.length) {
          if (!apiKey || !sourceObject.metadata.allowedApiKeys.includes(apiKey.key)) {
            throw Boom.unauthorized("Restricted source");
          }
        }
      }

      // OFAC blocklist
      if (await checkAddressIsBlockedByOFAC(payload.taker)) {
        throw Boom.unauthorized("Address is blocked by OFAC");
      }

      // Keep track of dynamically-priced orders (eg. from pools like Sudoswap and NFTX)
      const poolPrices: { [pool: string]: string[] } = {};
      // Keep track of the remaining quantities as orders are filled
      const quantityFilled: { [orderId: string]: number } = {};
      // Keep track of the maker balances as orders are filled
      const getMakerBalancesKey = (maker: string, contract: string, tokenId: string) =>
        `${maker}-${contract}-${tokenId}`;
      const makerBalances: { [makerAndToken: string]: BigNumber } = {};
      // TODO: Also keep track of the maker's allowance per exchange

      const sources = await Sources.getInstance();
      const feeRecipients = await FeeRecipients.getInstance();

      // Save the fill source if it doesn't exist yet
      if (payload.source) {
        await sources.getOrInsert(payload.source);
      }

      const conduitKey = getConduitKeyWithDefault(payload.conduitKey);

      // First pass at estimating the gas costs
      const txTags = initializeTxTags();

      const addToPath = async (
        order: {
          id: string;
          kind: OrderKind;
          maker: string;
          nativePrice: string;
          price: string;
          sourceId: number | null;
          currency: string;
          rawData: object;
          builtInFees: { kind: string; recipient: string; bps: number }[];
          additionalFees?: Sdk.RouterV6.Types.Fee[];
          isNativeOffChainCancellable: boolean | null;
        },
        token: {
          kind: "erc721" | "erc1155";
          contract: string;
          tokenId?: string;
          quantity?: number;
        }
      ) => {
        // Handle dynamically-priced orders
        if (["sudoswap", "sudoswap-v2", "nftx", "nftx-v3", "zora-v4"].includes(order.kind)) {
          let poolId: string;
          let priceList: string[];

          if (["sudoswap", "sudoswap-v2"].includes(order.kind)) {
            const rawData = order.rawData as Sdk.Sudoswap.OrderParams;
            poolId = rawData.pair;
            priceList = rawData.extra.prices;
          } else {
            const rawData = order.rawData as Sdk.Nftx.Types.OrderParams;
            poolId = rawData.pool;
            priceList = rawData.extra.prices;
          }

          if (!poolPrices[poolId]) {
            poolPrices[poolId] = [];
          }

          // Fetch the price corresponding to the order's index per pool
          const price = priceList[Math.min(poolPrices[poolId].length, priceList.length - 1)];
          // Save the latest price per pool
          poolPrices[poolId].push(price);
          // Override the order's price
          order.price = price;
        }

        // Increment the order's quantity filled
        const quantity = token.quantity ?? 1;
        if (!quantityFilled[order.id]) {
          quantityFilled[order.id] = 0;
        }
        quantityFilled[order.id] += quantity;

        if (order.kind !== "mint") {
          // Decrement the maker's available NFT balance
          const key = getMakerBalancesKey(order.maker, token.contract, token.tokenId!);
          if (!makerBalances[key]) {
            makerBalances[key] = await commonHelpers.getNftBalance(
              token.contract,
              token.tokenId!,
              order.maker
            );
          }
          makerBalances[key] = makerBalances[key].sub(quantity);
        }

        const unitPrice = bn(order.price);
        const additionalFees = payload.normalizeRoyalties ? order.additionalFees ?? [] : [];
        const builtInFees = order.builtInFees ?? [];

        const feeOnTop = additionalFees
          .map(({ amount }) => bn(amount))
          .reduce((a, b) => a.add(b), bn(0));

        const totalPrice = unitPrice.add(feeOnTop);
        const currency = await getCurrency(order.currency);
        path.push({
          orderId: order.id,
          contract: token.contract,
          tokenId: token.tokenId,
          quantity,
          source: order.sourceId !== null ? sources.get(order.sourceId)?.domain ?? null : null,
          currency: order.currency,
          currencySymbol: currency.symbol,
          currencyDecimals: currency.decimals,
          quote: formatPrice(totalPrice, currency.decimals, true),
          rawQuote: totalPrice.toString(),
          builtInFees: builtInFees.map((f) => {
            const rawAmount = unitPrice.mul(f.bps).div(10000).toString();
            const amount = formatPrice(rawAmount, currency.decimals);

            return {
              kind: f.kind,
              recipient: f.recipient,
              bps: f.bps,
              amount,
              rawAmount,
            };
          }),
          isNativeOffChainCancellable: order.isNativeOffChainCancellable,
          feesOnTop: [
            // For now, the only additional fees are the normalized royalties
            ...additionalFees.map((f) => ({
              kind: "royalty",
              recipient: f.recipient,
              bps: bn(f.amount).mul(10000).div(unitPrice).toNumber(),
              amount: formatPrice(f.amount, currency.decimals, true),
              rawAmount: bn(f.amount).toString(),
            })),
          ],
        });

        if (order.kind !== "mint") {
          let isFlagged = false;

          if (getOpenseaChainName()) {
            const flaggedResult = await idb.oneOrNone(
              `
              SELECT
                tokens.is_flagged
              FROM tokens
              WHERE tokens.contract = $/contract/
                AND tokens.token_id = $/tokenId/
              LIMIT 1
            `,
              {
                contract: toBuffer(token.contract),
                tokenId: token.tokenId,
              }
            );

            isFlagged = Boolean(flaggedResult.is_flagged);
          }

          try {
            listingDetails.push(
              await generateListingDetailsV6(
                {
                  id: order.id,
                  kind: order.kind,
                  currency: order.currency,
                  price: order.price,
                  source: path[path.length - 1].source ?? undefined,
                  rawData: order.rawData,
                  fees: additionalFees,
                },
                {
                  kind: token.kind,
                  contract: token.contract,
                  tokenId: token.tokenId!,
                  amount: token.quantity,
                  isFlagged,
                },
                payload.taker,
                {
                  relayer: payload.relayer,
                  ppV2TrustedChannel: payload.forwarderChannel,
                  skipOffChainCancellableIsFillableCheck:
                    request.headers["x-admin-api-key"] === config.adminApiKey
                      ? payload.skipOffChainCancellableIsFillableCheck
                      : false,
                }
              )
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (error: any) {
            // Remove the last path item
            path = path.slice(0, -1);

            if (!payload.partial) {
              throw getExecuteError(error.message ?? "Could not generate calldata");
            }
          }
        }

        txTags.feesOnTop! += additionalFees.length;
        if (order.kind === "mint") {
          txTags.mints! += 1;
        } else {
          if (!txTags.listings![order.kind]) {
            txTags.listings![order.kind] = 0;
          }
          txTags.listings![order.kind] += 1;
        }
      };

      const items: {
        token?: string;
        collection?: string;
        orderId?: string;
        rawOrder?: {
          kind: string;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: any;
        };
        quantity: number;
        preferredOrderSource?: string;
        preferredMintStage?: string;
        exactOrderSource?: string | string[];
        exclusions?: {
          orderId: string;
        }[];
        fillType?: "trade" | "mint" | "preferMint";
        originalItemIndex?: number;
      }[] = payload.items;

      // Keep track of any mint transactions that need to be aggregated
      const mintDetails: MintDetails[] = [];

      // Keep track of the maximum quantity available per item
      // (only relevant when the below `preview` field is true)
      const maxQuantities: {
        itemIndex: number;
        maxQuantity: string | null;
      }[] = [];
      const preview = payload.onlyPath && payload.partial && items.every((i) => !i.quantity);

      let allMintsHaveExplicitRecipient = true;

      let lastError: string | undefined;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemIndex =
          items[i].originalItemIndex !== undefined ? items[i].originalItemIndex! : i;

        if (!item.quantity) {
          if (preview) {
            item.quantity = 30;
          } else {
            item.quantity = 1;
          }
        }

        // Scenario 1: fill via `rawOrder`
        if (item.rawOrder) {
          const order = item.rawOrder;

          // Hack: As the raw order is processed, set it to the `orderId`
          // field so that it will get handled by the next pipeline step
          // of this same API rather than doing anything custom for it.

          // TODO: Handle any other on-chain orderbooks that cannot be "posted"
          if (order.kind === "mint") {
            const rawMint = order.data as PartialCollectionMint;

            const collectionData = await idb.oneOrNone(
              `
                SELECT
                  contracts.kind AS token_kind
                FROM collections
                JOIN contracts
                  ON collections.contract = contracts.address
                WHERE collections.id = $/id/
              `,
              {
                id: rawMint.collection,
              }
            );
            if (collectionData) {
              const collectionMint = normalizePartialCollectionMint(rawMint);

              const { txData, price, hasExplicitRecipient } = await generateCollectionMintTxData(
                collectionMint,
                payload.taker,
                item.quantity,
                {
                  comment: payload.comment,
                  referrer: payload.referrer,
                }
              );
              allMintsHaveExplicitRecipient = allMintsHaveExplicitRecipient && hasExplicitRecipient;

              const orderId = `mint:${collectionMint.collection}`;
              mintDetails.push({
                orderId,
                txData,
                fees: [],
                token: collectionMint.contract,
                quantity: item.quantity,
                comment: payload.comment,
                currency: collectionMint.currency,
                price: collectionMint.price,
              });

              await addToPath(
                {
                  id: orderId,
                  kind: "mint",
                  maker: collectionMint.contract,
                  nativePrice: price,
                  price: price,
                  sourceId: null,
                  currency: collectionMint.currency,
                  rawData: {},
                  builtInFees: [],
                  additionalFees: [],
                  isNativeOffChainCancellable: null,
                },
                {
                  kind: collectionData.token_kind,
                  contract: collectionMint.contract,
                  quantity: item.quantity,
                }
              );

              if (preview) {
                // The max quantity is the amount mintable on the collection
                maxQuantities.push({
                  itemIndex,
                  maxQuantity: null,
                });
              }
            }
          } else if (order.kind === "sudoswap") {
            item.orderId = sudoswap.getOrderId(order.data.pair, "sell", order.data.tokenId);
          } else if (order.kind === "nftx") {
            item.orderId = nftx.getOrderId(order.data.pool, "sell", order.data.specificIds[0]);
          } else if (order.kind === "blur-partial") {
            await addToPath(
              {
                id: keccak256(
                  ["string", "address", "uint256"],
                  ["blur", order.data.contract, order.data.tokenId]
                ),
                kind: "blur",
                maker: AddressZero,
                nativePrice: order.data.price,
                price: order.data.price,
                sourceId: sources.getByDomain("blur.io")?.id ?? null,
                currency: Sdk.Common.Addresses.Native[config.chainId],
                rawData: order.data,
                builtInFees: [],
                isNativeOffChainCancellable: isOrderNativeOffChainCancellable(order.data),
              },
              {
                kind: "erc721",
                contract: order.data.contract,
                tokenId: order.data.tokenId,
              }
            );

            if (preview) {
              // Blur only supports ERC721 listings so max quantity is always 1
              maxQuantities.push({
                itemIndex,
                maxQuantity: "1",
              });
            }
          } else {
            const response = await inject({
              method: "POST",
              url: `/order/v3`,
              headers: {
                "Content-Type": "application/json",
                "X-Api-Key": request.headers["x-api-key"],
              },
              payload: { order },
            }).then((response) => JSON.parse(response.payload));
            if (response.orderId) {
              item.orderId = response.orderId;
            } else {
              lastError = "Raw order failed to get processed";
              if (payload.partial) {
                continue;
              } else {
                throw getExecuteError(lastError);
              }
            }
          }
        }

        // Scenario 2: fill via `orderId`
        if (item.orderId) {
          const result = await idb.oneOrNone(
            `
              SELECT
                orders.id,
                orders.kind,
                contracts.kind AS token_kind,
                orders.price AS native_price,
                coalesce(orders.currency_price, orders.price) AS price,
                orders.raw_data,
                orders.source_id_int,
                orders.currency,
                orders.missing_royalties,
                orders.maker,
                orders.fee_breakdown,
                orders.fillability_status,
                orders.approval_status,
                orders.quantity_remaining,
                token_sets_tokens.contract,
                token_sets_tokens.token_id
              FROM orders
              JOIN contracts
                ON orders.contract = contracts.address
              JOIN token_sets_tokens
                ON orders.token_set_id = token_sets_tokens.token_set_id
              WHERE orders.id = $/id/
                AND orders.side = 'sell'
                AND (
                  orders.taker IS NULL
                  OR orders.taker = '\\x0000000000000000000000000000000000000000'
                  OR orders.taker = $/taker/
                )
                ${item.exclusions?.length ? " AND orders.id NOT IN ($/excludedOrderIds:list/)" : ""}
            `,
            {
              taker: toBuffer(payload.taker),
              id: item.orderId,
              excludedOrderIds: item.exclusions?.map((e) => e.orderId) ?? [],
            }
          );

          let error: string | undefined;
          if (!result) {
            error = "No fillable orders";
          } else {
            // Check fillability
            if (!error && !payload.allowInactiveOrderIds) {
              if (
                result.fillability_status === "no-balance" ||
                result.approval_status === "no-approval"
              ) {
                error = "Order is inactive (insufficient balance or approval) and can't be filled";
              } else if (result.fillability_status === "filled") {
                error = "Order has been filled";
              } else if (result.fillability_status === "cancelled") {
                error = "Order has been cancelled";
              } else if (result.fillability_status === "expired") {
                error = "Order has expired";
              } else if (
                result.fillability_status !== "fillable" ||
                result.approval_status !== "approved"
              ) {
                error = "No fillable orders";
              }
            }

            // Check taker
            if (!error) {
              if (fromBuffer(result.maker) === payload.taker) {
                error = "No fillable orders (taker cannot fill own orders)";
              }
            }

            // Check quantity
            if (!error) {
              if (bn(result.quantity_remaining).lt(item.quantity)) {
                if (!payload.partial) {
                  error = "Unable to fill requested quantity";
                  if (bn(result.quantity_remaining).isZero()) {
                    error += " (no orders remaining)";
                  }
                } else {
                  // Fill as much as we can from the order
                  item.quantity = result.quantity_remaining;
                }
              }
            }
          }

          if (error) {
            lastError = error;
            if (payload.partial) {
              continue;
            } else {
              throw getExecuteError(lastError);
            }
          }

          await addToPath(
            {
              id: result.id,
              kind: result.kind,
              maker: fromBuffer(result.maker),
              nativePrice: result.native_price,
              price: result.price,
              sourceId: result.source_id_int,
              currency: fromBuffer(result.currency),
              rawData: result.raw_data,
              builtInFees: result.fee_breakdown,
              additionalFees: result.missing_royalties,
              isNativeOffChainCancellable: isOrderNativeOffChainCancellable(result.raw_data),
            },
            {
              kind: result.token_kind,
              contract: fromBuffer(result.contract),
              tokenId: result.token_id,
              quantity: item.quantity,
            }
          );

          if (preview) {
            // The max quantity is the quantity still fillable on the order
            maxQuantities.push({
              itemIndex,
              maxQuantity: result.quantity_remaining,
            });
          }
        }

        // Scenario 3: fill via `collection`
        if (item.collection) {
          let mintAvailable = false;
          let hasActiveMints = false;
          if (item.fillType === "mint" || item.fillType === "preferMint") {
            const collectionData = await idb.oneOrNone(
              `
                SELECT
                  contracts.kind AS token_kind
                FROM collections
                JOIN contracts
                  ON collections.contract = contracts.address
                WHERE collections.id = $/id/
              `,
              {
                id: item.collection,
              }
            );
            if (collectionData) {
              // Fetch any open mints on the collection which the taker is elligible for
              const openMints = await mints.getCollectionMints(item.collection, {
                status: "open",
                stage: item.preferredMintStage,
              });

              for (const mint of openMints) {
                if (!payload.currency || mint.currency === payload.currency) {
                  const amountMintable = await mints.getAmountMintableByWallet(mint, payload.taker);
                  let quantityToMint = bn(
                    amountMintable
                      ? amountMintable.lt(item.quantity)
                        ? amountMintable
                        : item.quantity
                      : item.quantity
                  ).toNumber();

                  // If minting by collection was requested but the current mint is tied to a token,
                  // only mint a single quantity of the current token in order to match the logic of
                  // buying by collection (where we choose as many token ids as the quantity)
                  if (mint.tokenId) {
                    quantityToMint = Math.min(quantityToMint, 1);
                  }

                  if (quantityToMint > 0) {
                    try {
                      const { txData, price, hasExplicitRecipient } =
                        await generateCollectionMintTxData(mint, payload.taker, quantityToMint, {
                          comment: payload.comment,
                          referrer: payload.referrer,
                        });
                      allMintsHaveExplicitRecipient =
                        allMintsHaveExplicitRecipient && hasExplicitRecipient;

                      const orderId = `mint:${item.collection}`;
                      mintDetails.push({
                        orderId,
                        txData,
                        fees: [],
                        token: mint.contract,
                        quantity: quantityToMint,
                        comment: payload.comment,
                        currency: mint.currency,
                        price: mint.price,
                      });

                      await addToPath(
                        {
                          id: orderId,
                          kind: "mint",
                          maker: mint.contract,
                          nativePrice: price,
                          price: price,
                          sourceId: null,
                          currency: mint.currency,
                          rawData: {},
                          builtInFees: [],
                          additionalFees: [],
                          isNativeOffChainCancellable: null,
                        },
                        {
                          kind: collectionData.token_kind,
                          contract: mint.contract,
                          quantity: quantityToMint,
                        }
                      );

                      if (preview) {
                        // The max quantity is the amount mintable on the collection
                        maxQuantities.push({
                          itemIndex,
                          maxQuantity: mint.tokenId
                            ? quantityToMint.toString()
                            : amountMintable
                            ? amountMintable.toString()
                            : null,
                        });
                      }

                      item.quantity -= quantityToMint;
                      mintAvailable = true;
                    } catch {
                      // Skip errors
                      // Mostly coming from allowlist mints for which the user is not authorized
                      // TODO: Have an allowlist check instead of handling it via `try` / `catch`
                    }
                  }

                  hasActiveMints = true;
                }
              }
            }

            if (item.quantity > 0) {
              if (!hasActiveMints) {
                lastError = "Collection has no eligible mints";
              } else {
                lastError =
                  "Unable to mint requested quantity (max mints per wallet possibly exceeded)";
              }

              if (!payload.partial && mintAvailable) {
                throw getExecuteError(lastError);
              }
            }
          }

          if (item.fillType === "trade" || (item.fillType === "preferMint" && !mintAvailable)) {
            // Filtering by collection on the `orders` table is inefficient, so what we
            // do here is select the cheapest tokens from the `tokens` table and filter
            // out the ones that aren't fillable. For this to work we fetch more tokens
            // than we need, so we can filter out the ones that aren't fillable and not
            // end up with too few tokens.

            const redundancyFactor = 10;
            const tokenResults = await idb.manyOrNone(
              `
                WITH x AS (
                  SELECT
                    tokens.contract,
                    tokens.token_id,
                    ${
                      payload.normalizeRoyalties
                        ? "tokens.normalized_floor_sell_id"
                        : "tokens.floor_sell_id"
                    } AS order_id
                  FROM tokens
                  WHERE tokens.collection_id = $/collection/
                  ORDER BY ${
                    payload.normalizeRoyalties
                      ? "tokens.normalized_floor_sell_value"
                      : "tokens.floor_sell_value"
                  }
                  LIMIT $/quantity/ * ${redundancyFactor}
                )
                SELECT
                  x.contract,
                  x.token_id
                FROM x
                JOIN orders
                  ON x.order_id = orders.id
                WHERE orders.fillability_status = 'fillable'
                  AND orders.approval_status = 'approved'
                  AND orders.maker != $/taker/
                ORDER BY orders.value
                LIMIT $/quantity/
              `,
              {
                collection: item.collection,
                quantity: item.quantity,
                taker: toBuffer(payload.taker),
              }
            );

            if (preview) {
              const floorSellValueColumn = payload.normalizeRoyalties
                ? "tokens.normalized_floor_sell_value"
                : "tokens.floor_sell_value";
              const floorSellIdColumn = payload.normalizeRoyalties
                ? "tokens.normalized_floor_sell_id"
                : "tokens.floor_sell_id";

              const onSaleResults = await idb.manyOrNone(
                `
                  SELECT
                    orders.kind
                  FROM tokens
                  JOIN orders
                    ON orders.id = ${floorSellIdColumn}
                  WHERE tokens.collection_id = $/collection/
                    AND ${floorSellValueColumn} IS NOT NULL
                  ORDER BY ${floorSellValueColumn}
                `,
                {
                  collection: item.collection,
                }
              );

              const maxQuantity = String(onSaleResults.length);

              // The max quantity is the total number of tokens which can be bought from the collection
              maxQuantities.push({
                itemIndex,
                maxQuantity,
              });
            }

            // Add each retrieved token as a new item so that it will get
            // processed by the next pipeline of the same API rather than
            // building something custom for it.

            for (let i = 0; i < tokenResults.length; i++) {
              const t = tokenResults[i];
              items.push({
                token: `${fromBuffer(t.contract)}:${t.token_id}`,
                fillType: item.fillType,
                quantity: 1,
                originalItemIndex: itemIndex,
                preferredMintStage: item.preferredMintStage,
              });
            }

            if (tokenResults.length < item.quantity) {
              lastError = "Unable to fill requested quantity";
              if (tokenResults.length === 0) {
                lastError += " (no orders remaining)";
              }
              if (!payload.partial) {
                throw getExecuteError(lastError);
              }
            }
          }
        }

        // Scenario 4: fill via `token`
        if (item.token) {
          const [contract, tokenId] = item.token.split(":");

          let mintAvailable = false;
          let hasActiveMints = false;
          if (item.fillType === "mint" || item.fillType === "preferMint") {
            const collectionData = await idb.oneOrNone(
              `
                SELECT
                  collections.id,
                  contracts.kind AS token_kind
                FROM tokens
                JOIN collections
                  ON tokens.collection_id = collections.id
                JOIN contracts
                  ON collections.contract = contracts.address
                WHERE tokens.contract = $/contract/
                  AND tokens.token_id = $/tokenId/
              `,
              {
                contract: toBuffer(contract),
                tokenId,
              }
            );
            if (collectionData) {
              // Fetch any open mints on the token which the taker is elligible for
              const openMints = await mints.getCollectionMints(collectionData.id, {
                status: "open",
                tokenId,
                stage: item.preferredMintStage,
              });

              for (const mint of openMints) {
                if (!payload.currency || mint.currency === payload.currency) {
                  const amountMintable = await mints.getAmountMintableByWallet(mint, payload.taker);

                  const quantityToMint = bn(
                    amountMintable
                      ? amountMintable.lt(item.quantity)
                        ? amountMintable
                        : item.quantity
                      : item.quantity
                  ).toNumber();

                  if (quantityToMint > 0) {
                    try {
                      const { txData, price, hasExplicitRecipient } =
                        await generateCollectionMintTxData(mint, payload.taker, quantityToMint, {
                          comment: payload.comment,
                          referrer: payload.referrer,
                        });
                      allMintsHaveExplicitRecipient =
                        allMintsHaveExplicitRecipient && hasExplicitRecipient;

                      const orderId = `mint:${collectionData.id}`;
                      mintDetails.push({
                        orderId,
                        txData,
                        fees: [],
                        token: mint.contract,
                        quantity: quantityToMint,
                        comment: payload.comment,
                        currency: mint.currency,
                        price: mint.price,
                      });

                      await addToPath(
                        {
                          id: orderId,
                          kind: "mint",
                          maker: mint.contract,
                          nativePrice: price,
                          price: price,
                          sourceId: null,
                          currency: mint.currency,
                          rawData: {},
                          builtInFees: [],
                          additionalFees: [],
                          isNativeOffChainCancellable: null,
                        },
                        {
                          kind: collectionData.token_kind,
                          contract: mint.contract,
                          tokenId,
                          quantity: quantityToMint,
                        }
                      );

                      if (preview) {
                        // The max quantity is the amount mintable on the collection
                        maxQuantities.push({
                          itemIndex,
                          maxQuantity: amountMintable ? amountMintable.toString() : null,
                        });

                        // For minting, cross-chain filling is restricted to a single path item for now
                        if (path.length >= 1) {
                          break;
                        }
                      }

                      item.quantity -= quantityToMint;
                      mintAvailable = true;
                    } catch {
                      // Skip errors
                      // Mostly coming from allowlist mints for which the user is not authorized
                      // TODO: Have an allowlist check instead of handling it via `try` / `catch`
                    }
                  }

                  hasActiveMints = true;
                }
              }
            }

            if (item.quantity > 0) {
              if (!hasActiveMints) {
                lastError = "Token has no eligible mints";
              } else {
                lastError =
                  "Unable to mint requested quantity (max mints per wallet possibly exceeded)";
              }

              if (!payload.partial && mintAvailable) {
                throw getExecuteError(lastError);
              }
            }
          }

          if (item.fillType === "trade" || (item.fillType === "preferMint" && !mintAvailable)) {
            // TODO: Right now we filter out Blur orders since those don't yet
            // support royalty normalization. A better approach to handling it
            // would be to set the normalized fields to `null` for every order
            // which doesn't support royalty normalization and then filter out
            // such `null` fields in various normalized events/caches.

            let exactOrderSources: number[] = [];

            if (item.exactOrderSource) {
              if (!_.isArray(item.exactOrderSource)) {
                item.exactOrderSource = [item.exactOrderSource];
              }

              const sources = await Sources.getInstance();

              exactOrderSources = item.exactOrderSource
                .map((source: string) => sources.getByDomain(source)?.id ?? 0)
                .filter((id: number) => id != 0);
            }

            // Keep track of the max fillable quantity
            let maxQuantity = bn(0);

            // Fetch all matching orders sorted by price
            const orderResults = await idb.manyOrNone(
              `
                SELECT
                  orders.id,
                  orders.kind,
                  contracts.kind AS token_kind,
                  orders.price AS native_price,
                  coalesce(orders.currency_price, orders.price) AS price,
                  orders.quantity_remaining,
                  orders.source_id_int,
                  orders.currency,
                  orders.missing_royalties,
                  orders.maker,
                  orders.raw_data,
                  orders.fee_breakdown,
                  contracts.kind AS token_kind,
                  orders.quantity_remaining AS quantity
                FROM orders
                JOIN contracts
                  ON orders.contract = contracts.address
                WHERE orders.token_set_id = $/tokenSetId/
                  AND orders.side = 'sell'
                  AND orders.fillability_status = 'fillable'
                  AND orders.approval_status = 'approved'
                  AND (
                    orders.taker IS NULL
                    OR orders.taker = '\\x0000000000000000000000000000000000000000'
                    OR orders.taker = $/taker/
                  )
                  ${
                    payload.normalizeRoyalties || payload.excludeEOA
                      ? " AND orders.kind != 'blur'"
                      : ""
                  }
                  ${
                    exactOrderSources.length
                      ? " AND orders.source_id_int IN ($/sourceIds:csv/)"
                      : ""
                  }
                  ${
                    item.exclusions?.length
                      ? " AND orders.id NOT IN ($/excludedOrderIds:list/)"
                      : ""
                  }
                ORDER BY
                  ${payload.normalizeRoyalties ? "orders.normalized_value" : "orders.value"},
                  ${
                    item.preferredOrderSource
                      ? `(
                          CASE
                            WHEN orders.source_id_int = $/sortSourceId/ THEN 0
                            ELSE 1
                          END
                        )`
                      : "orders.fee_bps"
                  }
                LIMIT 1000
              `,
              {
                tokenSetId: `token:${item.token}`,
                quantity: item.quantity,
                sourceIds: exactOrderSources,
                sortSourceId: item.preferredOrderSource
                  ? sources.getByDomain(item.preferredOrderSource)?.id ?? -1
                  : undefined,
                taker: toBuffer(payload.taker),
                excludedOrderIds: item.exclusions?.map((e) => e.orderId) ?? [],
              }
            );

            let firstOrderKind: OrderKind | undefined;
            let quantityToFill = item.quantity;
            let makerEqualsTakerQuantity = 0;
            for (const result of orderResults) {
              // To make sure we don't run into number overflow
              const quantityRemaining = bn(result.quantity_remaining).gt(1000000)
                ? 1000000
                : Number(result.quantity_remaining);

              if (fromBuffer(result.maker) === payload.taker) {
                makerEqualsTakerQuantity += quantityRemaining;
                continue;
              }

              // Stop if we filled the total quantity
              if (quantityToFill <= 0 && !preview) {
                break;
              }

              // Account for the already filled order's quantity
              let availableQuantity = quantityRemaining;
              if (quantityFilled[result.id]) {
                availableQuantity -= quantityFilled[result.id];
              }

              // Account for the already filled maker's balance
              const maker = fromBuffer(result.maker);
              const key = getMakerBalancesKey(maker, contract, tokenId);
              if (makerBalances[key]) {
                const makerAvailableQuantity = makerBalances[key].toNumber();
                if (makerAvailableQuantity < availableQuantity) {
                  availableQuantity = makerAvailableQuantity;
                }
              }

              // Skip the current order if it has no quantity available
              if (availableQuantity <= 0) {
                continue;
              }

              await addToPath(
                {
                  id: result.id,
                  kind: result.kind,
                  maker,
                  nativePrice: result.native_price,
                  price: result.price,
                  sourceId: result.source_id_int,
                  currency: fromBuffer(result.currency),
                  rawData: result.raw_data,
                  builtInFees: result.fee_breakdown,
                  additionalFees: result.missing_royalties,
                  isNativeOffChainCancellable: isOrderNativeOffChainCancellable(result.raw_data),
                },
                {
                  kind: result.token_kind,
                  contract,
                  tokenId,
                  quantity: preview
                    ? availableQuantity
                    : Math.min(quantityToFill, availableQuantity),
                }
              );
              maxQuantity = maxQuantity.add(availableQuantity);

              // Update the quantity to fill with the current order's available quantity
              quantityToFill -= availableQuantity;

              // Make sure to save the kind of the first fillable order (needed for the cross-chain purchasing logic)
              if (!firstOrderKind) {
                firstOrderKind = result.kind;
              }
            }

            if (quantityToFill > 0) {
              if (makerEqualsTakerQuantity >= quantityToFill) {
                lastError = "No fillable orders (taker cannot fill own orders)";
              } else {
                lastError = "Unable to fill requested quantity";
                if (quantityToFill === item.quantity) {
                  lastError += " (no orders remaining)";
                }
              }

              if (!payload.partial) {
                throw getExecuteError(lastError);
              }
            }

            if (preview) {
              if (!maxQuantities.find((m) => m.itemIndex === itemIndex)) {
                maxQuantities.push({
                  itemIndex,
                  maxQuantity: maxQuantity.toString(),
                });
              }
            }
          }
        }
      }

      if (!path.length) {
        throw getExecuteError(lastError ?? "No fillable orders");
      }

      let buyInCurrency = payload.currency;
      if (!buyInCurrency) {
        // If no buy-in-currency is specified then we use the following defaults:
        if (path.length === 1) {
          // If a single order is to get filled, we use its currency
          buyInCurrency = path[0].currency;
        } else if (path.every((p) => p.currency === path[0].currency)) {
          // If multiple same-currency orders are to get filled, we use that currency
          buyInCurrency = path[0].currency;
        } else {
          // If multiple different-currency orders are to get filled, we use the native currency
          buyInCurrency = Sdk.Common.Addresses.Native[config.chainId];
        }
      }

      txTags.swaps! += new Set(
        path.filter((p) => p.currency !== buyInCurrency).map((p) => p.currency)
      ).size;

      // Include the global fees in the path

      const globalFees = (payload.feesOnTop ?? []).map((fee: string) => {
        const [recipient, amount] = fee.split(":");
        return { recipient, amount };
      });

      if (payload.source) {
        for (const globalFee of globalFees) {
          await feeRecipients.getOrInsert(globalFee.recipient, payload.source, "marketplace");
        }
      }

      const hasBlurListings = listingDetails.some((b) => b.source === "blur.io");
      const ordersEligibleForGlobalFees = listingDetails
        .filter(
          (b) =>
            // Any non-Blur orders
            b.source !== "blur.io" &&
            // Or if there are Blur orders we need to fill, any non-OpenSea or non-ERC721 orders
            (hasBlurListings
              ? !(["opensea.io"].includes(b.source!) && b.contractKind === "erc721")
              : true)
        )
        .map((b) => b.orderId);

      const addGlobalFee = async (
        detail: ListingDetails,
        item: (typeof path)[0],
        fee: Sdk.RouterV6.Types.Fee
      ) => {
        // The fees should be relative to a single quantity
        let feeAmount = bn(fee.amount).div(item.quantity).toString();

        // Global fees get split across all eligible orders
        let adjustedFeeAmount = bn(feeAmount).div(ordersEligibleForGlobalFees.length).toString();

        // If the item's currency is not the same with the buy-in currency,
        if (item.currency !== buyInCurrency) {
          feeAmount = await getUSDAndCurrencyPrices(
            buyInCurrency,
            item.currency,
            feeAmount,
            now()
          ).then((p) => p.currencyPrice!);
          adjustedFeeAmount = await getUSDAndCurrencyPrices(
            buyInCurrency,
            item.currency,
            adjustedFeeAmount,
            now()
          ).then((p) => p.currencyPrice!);
        }

        const amount = formatPrice(
          adjustedFeeAmount,
          (await getCurrency(item.currency)).decimals,
          true
        );
        const rawAmount = bn(adjustedFeeAmount).toString();

        // To avoid numeric overflow and division by zero
        const maxBps = bn(10000);
        const bps = bn(item.rawQuote).gt(0) ? bn(feeAmount).mul(10000).div(item.rawQuote) : maxBps;

        item.feesOnTop.push({
          recipient: fee.recipient,
          bps: bps.gt(maxBps) ? undefined : bps.toNumber(),
          amount,
          rawAmount,
        });

        item.totalPrice = (item.totalPrice ?? item.quote) + amount;
        item.totalRawPrice = bn(item.totalRawPrice ?? item.rawQuote)
          .add(rawAmount)
          .toString();

        if (!detail.fees) {
          detail.fees = [];
        }
        detail.fees.push({
          recipient: fee.recipient,
          amount: rawAmount,
        });
      };

      for (const item of path) {
        if (globalFees.length && ordersEligibleForGlobalFees.includes(item.orderId)) {
          for (const f of globalFees) {
            const detail = listingDetails.find((d) => d.orderId === item.orderId);
            if (detail) {
              await addGlobalFee(detail, item, f);
            }
          }
        } else {
          item.totalPrice = item.quote;
          item.totalRawPrice = item.rawQuote;
        }
      }

      // Add the quotes in the "buy-in" currency to the path items
      for (const item of path) {
        if (item.currency !== buyInCurrency) {
          const buyInPrices = await getUSDAndCurrencyPrices(
            item.currency,
            buyInCurrency,
            item.rawQuote,
            now(),
            {
              acceptStalePrice: true,
            }
          );

          if (buyInPrices.currencyPrice) {
            const c = await getCurrency(buyInCurrency);
            item.buyInCurrency = c.contract;
            item.buyInCurrencyDecimals = c.decimals;
            item.buyInCurrencySymbol = c.symbol;
            item.buyInQuote = formatPrice(buyInPrices.currencyPrice, c.decimals, true);
            item.buyInRawQuote = buyInPrices.currencyPrice;
          }
        }
      }

      type StepType = {
        id: string;
        action: string;
        description: string;
        kind: string;
        items: {
          status: string;
          tip?: string;
          orderIds?: string[];
          data?: object;
          check?: {
            endpoint: string;
            method: "POST";
            body: object;
          };
          // TODO: To remove, only kept for backwards-compatibility reasons
          gasEstimate?: number;
        }[];
      };

      // Set up generic filling steps
      let steps: StepType[] = [
        {
          id: "auth",
          action: "Sign in",
          description: "Some marketplaces require signing an auth message before filling",
          kind: "signature",
          items: [],
        },
        {
          id: "currency-approval",
          action: "Approve exchange contract",
          description: "A one-time setup transaction to enable trading",
          kind: "transaction",
          items: [],
        },
        {
          id: "currency-permit",
          action: "Sign permits",
          description: "Sign permits for accessing the tokens in your wallet",
          kind: "signature",
          items: [],
        },
        {
          id: "pre-signature",
          action: "Sign data",
          description: "Some exchanges require signing additional data before filling",
          kind: "signature",
          items: [],
        },
        {
          id: "auth-transaction",
          action: "On-chain verification",
          description: "Some marketplaces require triggering an auth transaction before filling",
          kind: "transaction",
          items: [],
        },
        {
          id: "swap",
          action: "Swap tokens",
          description: "To swap the tokens you must confirm the transaction and pay the gas fee",
          kind: "transaction",
          items: [],
        },
        {
          id: "sale",
          action: "Confirm transaction in your wallet",
          description: "To purchase this item you must confirm the transaction and pay the gas fee",
          kind: "transaction",
          items: [],
        },
      ];

      const fees = {
        gas: await getJoiPriceObject(
          {
            gross: {
              amount: (await getGasFee()).mul(estimateGasFromTxTags(txTags)).toString(),
            },
          },
          // Gas fees are always paid in the native currency of the chain
          Sdk.Common.Addresses.Native[config.chainId]
        ),
      };
      if (payload.onlyPath) {
        return {
          path,
          maxQuantities: preview ? maxQuantities : undefined,
          fees,
          // TODO: To remove, only kept for backwards-compatibility
          gasEstimate: estimateGasFromTxTags(txTags),
        };
      }

      // Handle Blur authentication
      let blurAuth: b.Auth | undefined;
      if (path.some((p) => p.source === "blur.io")) {
        if (payload.blurAuth) {
          blurAuth = { accessToken: payload.blurAuth };
        } else {
          const blurAuthId = b.getAuthId(payload.taker);

          blurAuth = await b.getAuth(blurAuthId);
          if (!blurAuth) {
            const blurAuthChallengeId = b.getAuthChallengeId(payload.taker);

            let blurAuthChallenge = await b.getAuthChallenge(blurAuthChallengeId);
            if (!blurAuthChallenge) {
              blurAuthChallenge = (await axios
                .get(
                  `${config.orderFetcherBaseUrl}/api/blur-auth-challenge?taker=${payload.taker}&chainId=${config.chainId}`
                )
                .then((response) => response.data.authChallenge)) as b.AuthChallenge;

              await b.saveAuthChallenge(
                blurAuthChallengeId,
                blurAuthChallenge,
                // Give a 1 minute buffer for the auth challenge to expire
                Math.floor(new Date(blurAuthChallenge?.expiresOn).getTime() / 1000) - now() - 60
              );
            }

            steps[0].items.push({
              status: "incomplete",
              data: {
                sign: {
                  signatureKind: "eip191",
                  message: blurAuthChallenge.message,
                },
                post: {
                  endpoint: "/execute/auth-signature/v1",
                  method: "POST",
                  body: {
                    kind: "blur",
                    id: blurAuthChallengeId,
                  },
                },
              },
            });

            // Force the client to poll
            steps[1].items.push({
              status: "incomplete",
              tip: "This step is dependent on a previous step. Once you've completed it, re-call the API to get the data for this step.",
            });

            // Return early since any next steps are dependent on the Blur auth
            return {
              steps,
              path,
            };
          }
        }

        steps[0].items.push({
          status: "complete",
        });

        // No need to have the hacky fix here since for Blur the next step will always be "sale"
      }

      // Handle ERC721C authentication
      const unverifiedERC721CTransferValidators: string[] = [];
      await Promise.all(
        listingDetails.map(async (d) => {
          try {
            const configV1 = await erc721c.v1.getConfigFromDb(d.contract);
            const configV2 = await erc721c.v2.getConfigFromDb(d.contract);
            const configV3 = await erc721c.v3.getConfigFromDb(d.contract);

            if (
              (configV1 && [4, 6].includes(configV1.transferSecurityLevel)) ||
              (configV2 && [6, 8].includes(configV2.transferSecurityLevel)) ||
              (configV3 && [6, 8].includes(configV3.transferSecurityLevel))
            ) {
              const transferValidator = (configV1 ?? configV2 ?? configV3)!.transferValidator;

              const isVerified = await erc721c.isVerifiedEOA(transferValidator, payload.taker);
              if (!isVerified) {
                unverifiedERC721CTransferValidators.push(transferValidator);
              }
            }
          } catch {
            // Skip errors
          }
        })
      );
      if (unverifiedERC721CTransferValidators.length) {
        const erc721cAuthId = e.getAuthId(payload.taker);

        const erc721cAuth = await e.getAuth(erc721cAuthId);
        if (!erc721cAuth) {
          const erc721cAuthChallengeId = e.getAuthChallengeId(payload.taker);

          let erc721cAuthChallenge = await e.getAuthChallenge(erc721cAuthChallengeId);
          if (!erc721cAuthChallenge) {
            erc721cAuthChallenge = {
              message: "EOA",
              walletAddress: payload.taker,
            };

            await e.saveAuthChallenge(
              erc721cAuthChallengeId,
              erc721cAuthChallenge,
              // Give a 10 minute buffer for the auth challenge to expire
              10 * 60
            );
          }

          steps[0].items.push({
            status: "incomplete",
            data: {
              sign: {
                signatureKind: "eip191",
                message: erc721cAuthChallenge.message,
              },
              post: {
                endpoint: "/execute/auth-signature/v1",
                method: "POST",
                body: {
                  kind: "erc721c",
                  id: erc721cAuthChallengeId,
                },
              },
            },
          });

          // Force the client to poll
          steps[1].items.push({
            status: "incomplete",
            tip: "This step is dependent on a previous step. Once you've completed it, re-call the API to get the data for this step.",
          });

          // Return early since any next steps are dependent on the ERC721C auth
          return {
            steps,
            path,
          };
        }

        steps[0].items.push({
          status: "complete",
        });
        steps[1].items.push({
          status: "complete",
          // Hacky fix for: https://github.com/reservoirprotocol/reservoir-kit/pull/391
          data: {},
        });
      }

      const router = new Sdk.RouterV6.Router(config.chainId, baseProvider, {
        x2y2ApiKey: payload.x2y2ApiKey ?? config.x2y2ApiKey,
        openseaApiKey: payload.openseaApiKey,
        cbApiKey: config.cbApiKey,
        zeroExApiKey: config.zeroExApiKey,
        nftxApiKey: config.nftxApiKey,
        orderFetcherBaseUrl: config.orderFetcherBaseUrl,
        orderFetcherMetadata: {
          apiKey: await ApiKeyManager.getApiKey(request.headers["x-api-key"]),
        },
      });

      const errors: { orderId: string; message: string }[] = [];

      let result: FillListingsResult;
      try {
        result = await router.fillListingsTx(listingDetails, payload.taker, buyInCurrency, {
          source: payload.source,
          partial: payload.partial,
          forceRouter: payload.forceRouter,
          relayer: payload.relayer,
          usePermit: payload.usePermit,
          swapProvider: payload.swapProvider,
          blurAuth,
          conduitKey,
          onError: async (kind, error, data) => {
            errors.push({
              orderId: data.orderId,
              message: error.response?.data ? JSON.stringify(error.response.data) : error.message,
            });
            await fillErrorCallback(kind, error, data);
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        throw getExecuteError(error.message, errors);
      }

      const { txs, success, swaps } = result;

      // Check the swap price
      try {
        await validateSwapPrice(path, swaps ?? []);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        throw getExecuteError(error.message, errors);
      }

      // Add any mint transactions
      if (mintDetails.length) {
        if (!result.txs.length) {
          for (const md of mintDetails) {
            for (const fee of globalFees) {
              md.fees.push({
                recipient: fee.recipient,
                amount: bn(fee.amount).div(mintDetails.length).toString(),
              });
            }
          }
        }

        let mintsResult = await router.fillMintsTx(mintDetails, payload.taker, {
          source: payload.source,
          partial: payload.partial,
          relayer: payload.relayer,
        });

        // Minting via a smart contract proxy is complicated.
        // There are a lot of things that could go wrong:
        // - collection disallows minting from a smart contract
        // - the mint method is not standard (eg. not calling the standard ERC721/1155 hooks)

        // For this reason, before returning the router module calldata
        // we simulate it and make sure that a few conditions are met:
        // - there is at least one successful mint
        // - all minted tokens have the taker as the final owner (eg. nothing gets stuck in the router / module)

        let safeToUse = true;
        if (mintsResult.viaRouter) {
          for (const { txData, approvals } of mintsResult.txs) {
            // ERC20 mints (which will have a corresponding approval) need to be minted directly
            if (approvals.length) {
              safeToUse = false;
              continue;
            }

            const events = await getNFTTransferEvents(txData);
            if (!events.length) {
              // At least one successful mint
              safeToUse = false;
            } else {
              // Every token landed in the taker's wallet
              const uniqueTokens = [
                ...new Set(events.map((e) => `${e.contract}:${e.tokenId}`)).values(),
              ].map((t) => t.split(":"));
              for (const [contract, tokenId] of uniqueTokens) {
                if (
                  !events.find(
                    (e) =>
                      e.contract === contract && e.tokenId === tokenId && e.to === payload.taker
                  )
                ) {
                  safeToUse = false;
                  break;
                }
              }
            }
          }
        }

        if (mintsResult.viaRouter && !safeToUse) {
          if (payload.relayer) {
            throw Boom.badRequest("Relayer not supported for requested mints");
          }

          mintsResult = await router.fillMintsTx(mintDetails, payload.taker, {
            source: payload.source,
            forceDirectFilling: true,
          });
        }

        txs.push(
          ...mintsResult.txs.map(({ txData, orderIds, approvals }) => ({
            txData,
            orderIds,
            approvals,
            permits: [],
            preSignatures: [],
          }))
        );

        Object.assign(success, mintsResult.success);
      }

      // Filter out any non-fillable orders from the path
      path = path.filter((p) => success[p.orderId]);

      if (!path.length) {
        throw getExecuteError("No fillable orders");
      }

      // Cannot skip balance checking when filling Blur orders
      if (payload.skipBalanceCheck && path.some((p) => p.source === "blur.io")) {
        payload.skipBalanceCheck = false;
      }

      // Custom gas settings
      const maxFeePerGas = payload.maxFeePerGas
        ? bn(payload.maxFeePerGas).toHexString()
        : undefined;
      const maxPriorityFeePerGas = payload.maxPriorityFeePerGas
        ? bn(payload.maxPriorityFeePerGas).toHexString()
        : undefined;

      const permitHandler = new PermitHandler(config.chainId, baseProvider);
      for (const { txData, approvals, permits, preSignatures } of txs) {
        // Handle approvals
        for (const approval of approvals) {
          const approvedAmount = await onChainData
            .fetchAndUpdateFtApproval(approval.currency, approval.owner, approval.operator)
            .then((a) => a.value);

          const isApproved = bn(approvedAmount).gte(approval.amount);
          if (!isApproved) {
            steps[1].items.push({
              status: "incomplete",
              data: {
                ...approval.txData,
                maxFeePerGas,
                maxPriorityFeePerGas,
              },
            });
          }
        }

        // Handle permits
        for (const permit of permits) {
          const id = getEphemeralPermitId(request.payload as object, {
            token: permit.data.token,
            amount: permit.data.amount,
          });

          const cachedPermit = await getEphemeralPermit(id);
          if (cachedPermit) {
            // Override with the cached permit data
            permit.data = cachedPermit.data;
          } else {
            // Cache the permit if it's the first time we encounter it
            await saveEphemeralPermit(id, permit);
          }

          // If the permit has a signature attached to it, we can skip it
          const hasSignature = permit.data.signature;
          if (hasSignature) {
            steps[2].items.push({
              status: "complete",
            });

            continue;
          }

          steps[2].items.push({
            status: "incomplete",
            data: {
              sign: await permitHandler.getSignatureData(permit),
              post: {
                endpoint: "/execute/permit-signature/v1",
                method: "POST",
                body: {
                  id,
                },
              },
            },
          });
        }

        // Handle pre-signatures
        const signaturesPaymentProcessor: string[] = [];
        for (const preSignature of preSignatures) {
          if (preSignature.kind === "payment-processor-take-order") {
            const id = getPreSignatureId(request.payload as object, {
              uniqueId: preSignature.uniqueId,
            });

            const cachedSignature = await getPreSignature(id);
            if (cachedSignature) {
              preSignature.signature = cachedSignature.signature;
            } else {
              await savePreSignature(id, preSignature);
            }

            const hasSignature = preSignature.signature;
            if (hasSignature) {
              signaturesPaymentProcessor.push(preSignature.signature!);

              steps[3].items.push({
                status: "complete",
              });

              continue;
            }

            steps[3].items.push({
              status: "incomplete",
              data: {
                sign: preSignature.data,
                post: {
                  endpoint: "/execute/pre-signature/v1",
                  method: "POST",
                  body: {
                    id,
                  },
                },
              },
            });
          }
        }

        if (signaturesPaymentProcessor.length && !steps[3].items.length) {
          const exchange = new Sdk.PaymentProcessor.Exchange(config.chainId);
          txData.data = exchange.attachTakerSignatures(txData.data, signaturesPaymentProcessor);
        }

        // Check that the transaction sender has enough funds to fill all requested tokens
        const txSender = payload.relayer ?? payload.taker;
        if (buyInCurrency === Sdk.Common.Addresses.Native[config.chainId]) {
          // Get the price in the buy-in currency via the transaction value
          const totalBuyInCurrencyPrice = bn(txData.value ?? 0);

          // Include the BETH balance when filling Blur orders
          const [nativeBalance, bethBalance] = await Promise.all([
            baseProvider.getBalance(txSender),
            hasBlurListings
              ? new Sdk.Common.Helpers.Erc20(
                  baseProvider,
                  Sdk.Blur.Addresses.Beth[config.chainId]
                ).getBalance(txSender)
              : Promise.resolve(bn(0)),
          ]);

          const balance = nativeBalance.add(bethBalance);
          if (!payload.skipBalanceCheck && bn(balance).lt(totalBuyInCurrencyPrice)) {
            throw getExecuteError(
              "Balance too low to proceed with transaction (use skipBalanceCheck=true to skip balance checking)"
            );
          }
        } else {
          // Get the price in the buy-in currency via the approval amounts
          const totalBuyInCurrencyPrice = approvals
            .map((a) => bn(a.amount))
            .reduce((a, b) => a.add(b), bn(0));

          const erc20 = new Sdk.Common.Helpers.Erc20(baseProvider, buyInCurrency);
          const balance = await erc20.getBalance(txSender);
          if (!payload.skipBalanceCheck && bn(balance).lt(totalBuyInCurrencyPrice)) {
            throw getExecuteError(
              "Balance too low to proceed with transaction (use skipBalanceCheck=true to skip balance checking)"
            );
          }
        }
      }

      // Handle on-chain authentication
      for (const tv of _.uniq(unverifiedERC721CTransferValidators)) {
        const erc721cAuthId = e.getAuthId(payload.taker);
        const erc721cAuth = await e.getAuth(erc721cAuthId);

        steps[4].items.push({
          status: "incomplete",
          // Do not return unless all previous steps are completed
          data:
            !steps[2].items.length && !steps[3].items.length
              ? new Sdk.Common.Helpers.Erc721C().generateVerificationTxData(
                  tv,
                  payload.taker,
                  erc721cAuth!.signature
                )
              : undefined,
        });
      }

      let hasSeparateSwaps = false;
      for (const { txData, txTags, orderIds, permits } of txs) {
        // Need a separate step for the swap-only transactions
        if (txTags && Object.keys(txTags).length === 1 && Object.keys(txTags)[0] === "swaps") {
          steps[5].items.push({
            status: "incomplete",
            orderIds,
            // Do not return unless all previous steps are completed
            data:
              !steps[2].items.filter((i) => i.status === "incomplete").length &&
              !steps[3].items.filter((i) => i.status === "incomplete").length
                ? {
                    ...txData,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                  }
                : undefined,
            // TODO: To remove, only kept for backwards-compatibility
            gasEstimate: txTags ? estimateGasFromTxTags(txTags) : undefined,
          });

          hasSeparateSwaps = true;
        } else {
          steps[6].items.push({
            status: "incomplete",
            orderIds,
            // Do not return unless all previous steps are completed
            data:
              !steps[2].items.filter((i) => i.status === "incomplete").length &&
              !steps[3].items.filter((i) => i.status === "incomplete").length
                ? {
                    ...permitHandler.attachToRouterExecution(txData, permits),
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                  }
                : undefined,
            check: {
              endpoint: "/execute/status/v1",
              method: "POST",
              body: {
                kind: "transaction",
              },
            },
            // TODO: To remove, only kept for backwards-compatibility
            gasEstimate: txTags ? estimateGasFromTxTags(txTags) : undefined,
          });
        }
      }

      // Warning! When filtering the steps, we should ensure that it
      // won't affect the client, which might be polling the API and
      // expect to get the steps returned in the same order / at the
      // same index.

      // We only filter the "currency-approval" step when there are no
      // auth transactions to be made otherwise due to how clients are
      // setup they might run into errors
      if (
        buyInCurrency === Sdk.Common.Addresses.Native[config.chainId] &&
        !unverifiedERC721CTransferValidators.length &&
        !steps.find(
          (s) =>
            s.id === "currency-approval" && s.items.find((item) => item.status === "incomplete")
        )
      ) {
        steps = steps.filter((s) => s.id !== "currency-approval");
      }
      if (!payload.usePermit) {
        // Permits are only used when explicitly requested
        steps = steps.filter((s) => s.id !== "currency-permit");
      }
      if (!blurAuth && !unverifiedERC721CTransferValidators.length) {
        // If we reached this point and the Blur auth is missing then we
        // can be sure that no Blur orders were requested and it is safe
        // to remove the auth step - we also handle other authentication
        // methods (eg. ERC721C)
        steps = steps.filter((s) => s.id !== "auth");
      }
      if (!unverifiedERC721CTransferValidators.length) {
        // For now only ERC721C uses the auth transaction step
        steps = steps.filter((s) => s.id !== "auth-transaction");
      }
      if (!listingDetails.some((d) => d.kind === "payment-processor")) {
        // For now, pre-signatures are only needed for `payment-processor` orders
        steps = steps.filter((s) => s.id !== "pre-signature");
      }
      if (!hasSeparateSwaps) {
        steps = steps.filter((s) => s.id !== "swap");
      }

      const executionsBuffer = new ExecutionsBuffer();
      for (const item of path) {
        executionsBuffer.addFromRequest(request, {
          side: "buy",
          action: "fill",
          user: payload.taker,
          orderId: item.orderId,
          quantity: item.quantity,
          ...txs.find((tx) => tx.orderIds.includes(item.orderId))?.txData,
        });
      }
      const requestId = await executionsBuffer.flush();

      return {
        requestId,
        steps: blurAuth ? [steps[0], ...steps.slice(1).filter((s) => s.items.length)] : steps,
        errors,
        path,
        fees,
      };
    } catch (error) {
      const key = request.headers["x-api-key"];
      const apiKey = await ApiKeyManager.getApiKey(key);
      logger.log(
        error instanceof Boom.Boom ? "warn" : "error",
        `get-execute-buy-${version}-handler`,
        JSON.stringify({
          request: payload,
          uuid: randomUUID(),
          httpCode: error instanceof Boom.Boom ? error.output.statusCode : 500,
          error:
            error instanceof Boom.Boom ? error.output.payload : { error: "Internal Server Error" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stack: (error as any).stack,
          apiKey,
        })
      );

      throw error;
    }
  },
};
