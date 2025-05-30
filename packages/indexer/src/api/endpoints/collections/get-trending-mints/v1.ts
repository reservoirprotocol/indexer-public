/* eslint-disable @typescript-eslint/no-explicit-any */

import { redb } from "@/common/db";
import { logger } from "@/common/logger";
import { formatEth, regex } from "@/common/utils";
import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { getTrendingMints } from "@/elasticsearch/indexes/activities";

import { getCollectionsMetadata } from "@/api/endpoints/collections/get-trending-collections/v1";
import {
  ElasticMintResult,
  Metadata,
  MetadataKey,
  Mint,
} from "@/api/endpoints/collections/get-trending-mints/interfaces";
import { JoiPrice, getJoiPriceObject } from "@/common/joi";
import { Sources } from "@/models/sources";
import { Assets } from "@/utils/assets";
import {
  MintingCollectionData,
  TrendingMintsMintingCollectionCache,
} from "@/models/trending-mints-minting-collection-cache";

const version = "v1";

export const getTrendingMintsV1Options: RouteOptions = {
  cache: {
    expiresIn: 60 * 1000,
    privacy: "public",
  },
  description: "Top Trending Mints",
  notes: "Get top trending mints",
  tags: ["api", "x-deprecated", "marketplace"],
  plugins: {
    "hapi-swagger": {
      order: 3,
      deprecated: true,
    },
  },
  validate: {
    query: Joi.object({
      period: Joi.string()
        .valid("5m", "10m", "30m", "1h", "2h", "6h", "24h")
        .default("24h")
        .description("Time window to aggregate."),
      type: Joi.string()
        .valid("free", "paid", "any")
        .default("any")
        .description("The type of the mint (free/paid)."),
      limit: Joi.number()
        .integer()
        .min(1)
        .max(200)
        .default(50)
        .description(
          "Amount of items returned in response. Default is 50 and max is 50. Expected to be sorted and filtered on client side."
        ),
      mintStandard: Joi.alternatives()
        .try(Joi.array().max(20).items(Joi.string()), Joi.string())
        .description("The standard of the mint."),
      normalizeRoyalties: Joi.boolean()
        .default(false)
        .description("If true, prices will include missing royalties to be added on-top."),
      useNonFlaggedFloorAsk: Joi.boolean()
        .when("normalizeRoyalties", {
          is: Joi.boolean().valid(true),
          then: Joi.valid(false),
        })
        .default(false)
        .description(
          "If true, return the non flagged floor ask. Supported only when `normalizeRoyalties` is false."
        ),
    }),
  },
  response: {
    schema: Joi.object({
      mints: Joi.array().items(
        Joi.object({
          id: Joi.string().description("Collection id"),
          name: Joi.string().allow("", null),
          image: Joi.string().allow("", null),
          banner: Joi.string().allow("", null),
          isSpam: Joi.boolean().default(false),
          openseaVerificationStatus: Joi.string().allow("", null),
          magicedenVerificationStatus: Joi.string().allow("", null),
          description: Joi.string().allow("", null),
          primaryContract: Joi.string().lowercase().pattern(regex.address),
          contract: Joi.string().lowercase().pattern(regex.address),
          volumePercentChange: Joi.number().unsafe().allow(null),
          countPercentChange: Joi.number().unsafe().allow(null),
          creator: Joi.string().allow("", null),
          onSaleCount: Joi.number().integer(),
          floorAsk: {
            id: Joi.string().allow(null),
            sourceDomain: Joi.string().allow("", null),
            price: JoiPrice.allow(null),
            maker: Joi.string().lowercase().pattern(regex.address).allow(null),
            validFrom: Joi.number().unsafe().allow(null),
            validUntil: Joi.number().unsafe().allow(null),
            token: Joi.object({
              contract: Joi.string().lowercase().pattern(regex.address).allow(null),
              tokenId: Joi.string().pattern(regex.number).allow(null),
              name: Joi.string().allow(null),
              image: Joi.string().allow("", null),
            })
              .allow(null)
              .description("Lowest Ask Price."),
          },
          tokenCount: Joi.number().description("Total tokens within the collection."),
          ownerCount: Joi.number().description("Unique number of owners."),
          isMinting: Joi.boolean(),
          createdAt: Joi.date().allow("", null),
          startDate: Joi.date().allow("", null),
          endDate: Joi.date().allow("", null),
          maxSupply: Joi.number().allow(null),
          mintPrice: Joi.string().allow(null),
          sampleImages: Joi.array().items(Joi.string().allow("", null)),
          mintVolume: Joi.number().allow(null),
          mintCount: Joi.number().allow(null),
          sixHourCount: Joi.number().allow(null),
          oneHourCount: Joi.number().allow(null),
          mintType: Joi.string().allow("free", "paid", "", null),
          mintStandard: Joi.string().allow("", null),
          mintedTimestamp: Joi.number().allow(null),
          lastMintTimestamp: Joi.number().allow(null),
          mintStatus: Joi.string().allow("", null),
          mintStages: Joi.array().items(
            Joi.object({
              stage: Joi.string().allow(null),
              tokenId: Joi.string().pattern(regex.number).allow(null),
              kind: Joi.string().required(),
              price: JoiPrice.allow(null),
              startTime: Joi.number().allow(null),
              endTime: Joi.number().allow(null),
              maxMintsPerWallet: Joi.number().unsafe().allow(null),
            })
          ),

          collectionVolume: Joi.object({
            "1day": Joi.number().unsafe().allow(null),
            "7day": Joi.number().unsafe().allow(null),
            "30day": Joi.number().unsafe().allow(null),
            allTime: Joi.number().unsafe().allow(null),
          }).description("Total volume in given time period."),

          volumeChange: Joi.object({
            "1day": Joi.number().unsafe().allow(null),
            "7day": Joi.number().unsafe().allow(null),
            "30day": Joi.number().unsafe().allow(null),
          }).description(
            "Total volume change X-days vs previous X-days. (e.g. 7day [days 1-7] vs 7day prior [days 8-14]). A value over 1 is a positive gain, under 1 is a negative loss. e.g. 1 means no change; 1.1 means 10% increase; 0.9 means 10% decrease."
          ),
        })
      ),
    }).label(`get-trending-mints${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-trending-mints-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async ({ query }: Request, h) => {
    const { normalizeRoyalties, useNonFlaggedFloorAsk, type, period, limit, mintStandard } = query;

    let mintStandards = [];

    if (mintStandard) {
      if (!Array.isArray(mintStandard)) {
        mintStandards = [mintStandard];
      } else {
        mintStandards = mintStandard;
      }
    }

    const trendingMints = await getTrendingMints({
      type,
      period,
      limit,
      mintStandards,
    });

    if (trendingMints.length < 1) {
      const response = h.response({ mints: [] });
      return response;
    }

    const collectionsMetadata = await getCollectionsMetadata(trendingMints);
    const mintStages = await getMintStages(Object.keys(collectionsMetadata));

    const mints = await formatCollections(
      mintStages,
      trendingMints,
      collectionsMetadata,
      normalizeRoyalties,
      useNonFlaggedFloorAsk,
      type
    );

    return h.response({ mints });
  },
};

async function getMintStages(contracts: string[]): Promise<Record<string, Mint["mint_stages"]>> {
  const baseQuery = `
    SELECT collection_id, array_agg(
      json_build_object(
        'stage', collection_mints.stage,
        'tokenId', collection_mints.token_id::TEXT,
        'kind', collection_mints.kind,
        'currency', concat('0x', encode(collection_mints.currency, 'hex')),
        'price', collection_mints.price::TEXT,
        'startTime', floor(extract(epoch from collection_mints.start_time)),
        'endTime', floor(extract(epoch from collection_mints.end_time)),
        'maxMintsPerWallet', collection_mints.max_mints_per_wallet
      )
    ) as mint_stages
    FROM collection_mints
    WHERE collection_mints.collection_id IN (${contracts
      .map((contract) => `'${contract}'`)
      .join(",")})
    GROUP BY collection_id`;

  const result = await redb.manyOrNone<{ collection_id: string; mint_stages: Mint["mint_stages"] }>(
    baseQuery
  );

  const data: Record<string, Mint["mint_stages"]> = {};
  result.forEach((res) => {
    data[res.collection_id] = [...res.mint_stages];
  });

  return data;
}

async function formatCollections(
  mintStages: Record<string, Mint["mint_stages"]>,
  collectionsResult: ElasticMintResult[],
  collectionsMetadata: Record<string, Metadata>,
  normalizeRoyalties: boolean,
  useNonFlaggedFloorAsk: boolean,
  mintType: string
): Promise<any[]> {
  const sources = await Sources.getInstance();

  const mintingCollections: MintingCollectionData[] =
    await TrendingMintsMintingCollectionCache.getMintingCollections(
      collectionsResult.map((r) => r.id)
    );

  const collections = await Promise.all(
    collectionsResult.map(async (r) => {
      const mintData = {
        ...mintingCollections.find((c) => c.collection_id == r.id),
        mint_stages: mintStages[r.id],
      };

      const metadata = collectionsMetadata[r.id];
      let floorAsk;
      let prefix = "";

      if (normalizeRoyalties) {
        prefix = "normalized_";
      } else if (useNonFlaggedFloorAsk) {
        prefix = "non_flagged_";
      }
      const floorAskId = metadata[`${prefix}floor_sell_id` as MetadataKey];
      const floorAskValue = metadata[`${prefix}floor_sell_value` as MetadataKey];
      const floorAskCurrency = metadata.floor_sell_currency as MetadataKey;
      const floorAskSource = metadata[`${prefix}floor_sell_source_id_int` as MetadataKey];
      const floorAskCurrencyValue =
        metadata[
          `${normalizeRoyalties ? "normalized_" : ""}floor_sell_currency_value` as MetadataKey
        ];

      if (metadata) {
        floorAsk = {
          id: floorAskId,
          sourceDomain: sources.get(floorAskSource)?.domain,
          price: floorAskId
            ? await getJoiPriceObject(
                {
                  gross: {
                    amount: floorAskCurrencyValue ?? floorAskValue,
                    nativeAmount: floorAskValue || 0,
                  },
                },
                floorAskCurrency
              )
            : null,
        };
      }

      return {
        id: metadata?.id,
        image:
          metadata?.metadata?.imageUrl ??
          (metadata?.sample_images?.length
            ? Assets.getResizedImageURLs(metadata.sample_images[0])
            : null),
        banner: metadata?.metadata ? metadata.metadata?.bannerImageUrl : null,
        name: metadata ? metadata?.name : "",
        description: metadata?.metadata ? metadata.metadata?.description : null,
        isSpam: Number(metadata.is_spam) > 0,
        isMinting: mintData.kind === "public" && mintData.status === "open",
        onSaleCount: Number(metadata.on_sale_count) || 0,
        volumeChange: {
          "1day": Number(metadata.day1_volume_change),
          "7day": Number(metadata.day7_volume_change),
          "30day": Number(metadata.day30_volume_change),
        },
        collectionVolume: {
          "1day": metadata.day1_volume ? formatEth(metadata.day1_volume) : null,
          "7day": metadata.day7_volume ? formatEth(metadata.day7_volume) : null,
          "30day": metadata.day30_volume ? formatEth(metadata.day30_volume) : null,
          allTime: metadata.all_time_volume ? formatEth(metadata.all_time_volume) : null,
        },
        tokenCount: Number(metadata.token_count || 0),
        ownerCount: Number(metadata.owner_count || 0),
        sampleImages:
          metadata?.sample_images && metadata?.sample_images?.length > 0
            ? Assets.getResizedImageURLs(metadata?.sample_images)
            : [],
        mintType: mintType === "any" ? (Number(mintData?.price) > 0 ? "paid" : "free") : mintType,
        mintPrice: mintType === "free" ? "0" : mintData?.price,
        maxSupply: Number.isSafeInteger(Number(mintData?.max_supply))
          ? Number(mintData?.max_supply)
          : null,
        mintStandard: mintData?.standard || "unknown",
        createdAt: mintData?.created_at && new Date(mintData?.created_at).toISOString(),
        startDate: mintData?.start_time && new Date(mintData?.start_time).toISOString(),
        endDate: mintData?.end_time && new Date(mintData?.end_time).toISOString(),
        mintCount: r?.mintCount || 0,
        sixHourCount: r.sixHourResult?.mintCount || 0,
        oneHourCount: r.oneHourResult?.mintCount || 0,
        mintVolume: r.volume,
        openseaVerificationStatus: metadata?.metadata?.openseaVerificationStatus || null,
        magicedenVerificationStatus: metadata?.metadata?.magicedenVerificationStatus || null,
        mintedTimestamp: metadata.minted_timestamp,
        lastMintTimestamp: metadata.last_mint_timestamp,
        mintStages:
          mintData?.mint_stages?.length > 0
            ? await Promise.all(
                mintData.mint_stages.map(async (m: Mint["mint_stages"][0]) => {
                  return {
                    stage: m?.stage || null,
                    kind: m?.kind || null,
                    tokenId: m?.tokenId || null,
                    price: m?.price
                      ? await getJoiPriceObject({ gross: { amount: m.price } }, m.currency)
                      : null,
                    startTime: m?.startTime ? m?.startTime : null,
                    endTime: m?.endTime ? m?.endTime : null,
                    maxMintsPerWallet: m?.maxMintsPerWallet || null,
                  };
                })
              )
            : [],
        floorAsk,
        creator: metadata.creator,
      };
    })
  );

  return collections;
}
