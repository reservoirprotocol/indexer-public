import { Interface, Result } from "@ethersproject/abi";
import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import * as Sdk from "@reservoir0x/sdk";
import _ from "lodash";
import { Mutex, withTimeout } from "async-mutex";

import { idb } from "@/common/db";
import { baseProvider } from "@/common/provider";
import { redis } from "@/common/redis";
import { toBuffer, bn } from "@/common/utils";
import { config } from "@/config/index";
import { isNonceCancelled } from "@/orderbook/orders/common/helpers";
import { Royalty, refreshDefaultRoyalties, updateRoyaltySpec } from "@/utils/royalties";

export enum PaymentSettings {
  DefaultPaymentMethodWhitelist = 0,
  AllowAnyPaymentMethod = 1,
  CustomPaymentMethodWhitelist = 2,
  PricingConstraints = 3,
}

export type CollectionPaymentSettings = {
  paymentSettings: PaymentSettings;
  constrainedPricingPaymentMethod: string;
  royaltyBackfillNumerator: number;
  royaltyBountyNumerator: number;
  royaltyBackfillReceiver: string;
  isRoyaltyBountyExclusive: boolean;
  blockTradesFromUntrustedChannels: boolean;
  blockBannedAccounts: boolean;
  pricingBounds?: PricingBounds;
  whitelistedPaymentMethods: string[];
};

export type TrustedChannel = {
  channel: string;
  signer: string;
};

export type PricingBounds = {
  floorPrice: string;
  ceilingPrice: string;
};

// Collection configuration

export const getConfigByContract = async (
  contract: string,
  refresh?: boolean
): Promise<CollectionPaymentSettings | undefined> => {
  const cacheKey = `pp-v2-config-by-contract:${contract}`;

  let result = await redis
    .get(cacheKey)
    .then((r) => (r ? (JSON.parse(r) as CollectionPaymentSettings) : undefined));
  if (!result || refresh) {
    try {
      const exchange = new Contract(
        Sdk.PaymentProcessorV2.Addresses.Exchange[config.chainId],
        new Interface([
          `function collectionPaymentSettings(address token) view returns (
            (
              uint8 paymentSettings,
              uint32 paymentMethodWhitelistId,
              address constrainedPricingPaymentMethod,
              uint16 royaltyBackfillNumerator,
              uint16 royaltyBountyNumerator,
              bool isRoyaltyBountyExclusive,
              bool blockTradesFromUntrustedChannels,
              bool blockBannedAccounts
            )
          )`,
          `function collectionRoyaltyBackfillSettings(address token) view returns (
            (
              uint16 royaltyBackfillNumerator,
              address royaltyBackfillReceiver
            )
          )`,
          "function getFloorPrice(address token, uint256 tokenId) view returns (uint256)",
          "function getCeilingPrice(address token, uint256 tokenId) view returns (uint256)",
        ]),
        baseProvider
      );

      const paymentSettings = await exchange.collectionPaymentSettings(contract);
      const royaltyBackfill = await exchange.collectionRoyaltyBackfillSettings(contract);

      result = {
        paymentSettings: paymentSettings.paymentSettings,
        constrainedPricingPaymentMethod:
          paymentSettings.constrainedPricingPaymentMethod.toLowerCase(),
        royaltyBackfillNumerator: paymentSettings.royaltyBackfillNumerator,
        royaltyBountyNumerator: paymentSettings.royaltyBountyNumerator,
        royaltyBackfillReceiver: royaltyBackfill.royaltyBackfillReceiver.toLowerCase(),
        isRoyaltyBountyExclusive: paymentSettings.isRoyaltyBountyExclusive,
        blockTradesFromUntrustedChannels: paymentSettings.blockTradesFromUntrustedChannels,
        blockBannedAccounts: paymentSettings.blockBannedAccounts,
        whitelistedPaymentMethods:
          paymentSettings.paymentSettings === PaymentSettings.DefaultPaymentMethodWhitelist
            ? await getDefaultPaymentMethods()
            : await getPaymentMethods(paymentSettings.paymentMethodWhitelistId, refresh),
      };

      if (result?.paymentSettings === PaymentSettings.PricingConstraints) {
        const pricingBounds = {
          floorPrice: await exchange
            .getFloorPrice(contract, "0")
            .then((p: BigNumber) => p.toString()),
          ceilingPrice: await exchange
            .getCeilingPrice(contract, "0")
            .then((p: BigNumber) => p.toString()),
        };
        result.pricingBounds = pricingBounds;
      }

      if (result) {
        await redis.set(cacheKey, JSON.stringify(result), "EX", 3 * 3600);
      }
    } catch {
      // Skip errors
    }
  }

  return result;
};

// Trusted channels

export const getTrustedChannels = async (contract: string, refresh?: boolean) => {
  const cacheKey = `pp-v2-trusted-channels:${contract}`;

  let result = await redis
    .get(cacheKey)
    .then((r) => (r ? (JSON.parse(r) as TrustedChannel[]) : undefined));
  if (!result || refresh) {
    try {
      const exchange = new Contract(
        Sdk.PaymentProcessorV2.Addresses.Exchange[config.chainId],
        new Interface(["function getTrustedChannels(address token) view returns (address[])"]),
        baseProvider
      );

      const trustedChannels = await exchange.getTrustedChannels(contract);
      const trustedChannelsWithSigners: {
        channel: string;
        signer: string;
      }[] = [];

      await Promise.all(
        trustedChannels
          .map((c: Result) => c.toLowerCase())
          .map(async (channel: string) => {
            try {
              const channelContract = new Contract(
                channel,
                new Interface(["function signer() view returns (address)"]),
                baseProvider
              );

              const signer = await channelContract.callStatic.signer();
              trustedChannelsWithSigners.push({
                channel: channel.toLowerCase(),
                signer: signer.toLowerCase(),
              });
            } catch {
              // Skip errors
            }
          })
      );

      result = trustedChannelsWithSigners;
      await redis.set(cacheKey, JSON.stringify(result), "EX", 3 * 3600);
    } catch {
      // Skip errors
    }
  }

  return result ?? [];
};

// Payment methods

export const getDefaultPaymentMethods = async (): Promise<string[]> => {
  const cacheKey = "pp-v2-default-payment-methods";

  let result = await redis.get(cacheKey).then((r) => (r ? (JSON.parse(r) as string[]) : undefined));
  if (!result) {
    const exchange = new Contract(
      Sdk.PaymentProcessorV2.Addresses.Exchange[config.chainId],
      new Interface(["function getDefaultPaymentMethods() view returns (address[])"]),
      baseProvider
    );

    result = await exchange
      .getDefaultPaymentMethods()
      .then((c: Result) => c.map((d) => d.toLowerCase()));
    await redis.set(cacheKey, JSON.stringify(_.uniq(result)), "EX", 7 * 24 * 3600);
  }

  return result!;
};

export const getPaymentMethods = async (paymentMethodWhitelistId: number, refresh?: boolean) => {
  const cacheKey = `pp-v2-payment-methods:${paymentMethodWhitelistId}`;

  let result = await redis.get(cacheKey).then((r) => (r ? (JSON.parse(r) as string[]) : undefined));
  if (!result || refresh) {
    try {
      const exchange = new Contract(
        Sdk.PaymentProcessorV2.Addresses.Exchange[config.chainId],
        new Interface([
          "function getWhitelistedPaymentMethods(uint32 paymentMethodWhitelistId) view returns (address[])",
        ]),
        baseProvider
      );

      result = await exchange
        .getWhitelistedPaymentMethods(paymentMethodWhitelistId)
        .then((c: Result) => c.map((d) => d.toLowerCase()));
      await redis.set(cacheKey, JSON.stringify(_.uniq(result)), "EX", 3 * 3600);
    } catch {
      // Skip errors
    }
  }

  return result ?? [];
};

// Banned accounts

export const getBannedAccounts = async (contract: string, refresh?: boolean) => {
  const cacheKey = `pp-v2-banned-accounts:${contract}`;

  let result = await redis.get(cacheKey).then((r) => (r ? (JSON.parse(r) as string[]) : undefined));
  if (!result || refresh) {
    try {
      const exchange = new Contract(
        Sdk.PaymentProcessorV2.Addresses.Exchange[config.chainId],
        new Interface(["function getBannedAccounts(address token) view returns (address[])"]),
        baseProvider
      );

      result = await exchange
        .getBannedAccounts(contract)
        .then((c: Result) => c.map((d) => d.toLowerCase()));
      await redis.set(cacheKey, JSON.stringify(result), "EX", 3 * 3600);
    } catch {
      // Skip errors
    }
  }

  return result ?? [];
};

export const checkAccountIsBanned = async (token: string, account: string) => {
  const bannedAccounts = await getBannedAccounts(token);
  return bannedAccounts.includes(account);
};

// Backfilled royalties

export const saveBackfilledRoyalties = async (tokenAddress: string, royalties: Royalty[]) => {
  await updateRoyaltySpec(
    tokenAddress,
    "pp-v2-backfill",
    royalties.some((r) => r.recipient !== AddressZero) ? royalties : undefined
  );
  await refreshDefaultRoyalties(tokenAddress, "pp-v2-backfill");
};

// Nonce tracking

// The execution of the below method should happen atomically, pr otherwise
// we could have multiple orders sharing the same nonce (which means only a
// single one of these orders will actually be fillable - nonces are unique
// per order)

const mutex = withTimeout(new Mutex(), 5000);
export const getAndIncrementUserNonce = async (
  orderKind: "payment-processor-v2" | "payment-processor-v2.1",
  user: string,
  marketplace: string
): Promise<string | undefined> => {
  const tableName =
    orderKind === "payment-processor-v2"
      ? "payment_processor_v2_user_nonces"
      : "payment_processor_v21_user_nonces";
  return mutex
    .runExclusive(async () => {
      let nextNonce = await idb
        .oneOrNone(
          `
            SELECT
              ${tableName}.nonce
            FROM ${tableName}
            WHERE ${tableName}.user = $/user/
              AND ${tableName}.marketplace = $/marketplace/
          `,
          {
            user: toBuffer(user),
            marketplace: toBuffer(marketplace),
          }
        )
        .then((r) => r?.nonce ?? "0");

      const shiftedMarketplaceId = bn("0x" + marketplace.slice(-8).padEnd(64, "0"));
      nextNonce = shiftedMarketplaceId.add(nextNonce).toString();

      // At most 20 attempts
      let foundValidNonce = false;
      for (let i = 0; i < 20; i++) {
        const isCancelled = await isNonceCancelled(orderKind, user, nextNonce);
        if (isCancelled) {
          nextNonce = bn(nextNonce).add(1).toString();
        } else {
          foundValidNonce = true;
          break;
        }
      }

      if (!foundValidNonce) {
        return undefined;
      }

      await idb.none(
        `
          INSERT INTO ${tableName} (
            "user",
            marketplace,
            nonce
          ) VALUES (
            $/user/,
            $/marketplace/,
            $/nonce/
          ) ON CONFLICT ("user", marketplace) DO UPDATE SET
            nonce = $/nonce/,
            updated_at = now()
        `,
        {
          user: toBuffer(user),
          marketplace: toBuffer(marketplace),
          nonce: bn(nextNonce).add(1).sub(shiftedMarketplaceId).toString(),
        }
      );

      return nextNonce;
    })
    .catch(() => {
      return undefined;
    });
};
