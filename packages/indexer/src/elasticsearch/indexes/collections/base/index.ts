/* eslint-disable @typescript-eslint/no-explicit-any */

import { config } from "@/config/index";
import { logger } from "@/common/logger";

import { formatEth, fromBuffer } from "@/common/utils";
import { getChainName } from "@/config/network";

import { BuildDocumentData, BaseDocument } from "@/elasticsearch/indexes/base";
import { getUsdPrice } from "@/elasticsearch/indexes/utils";

export interface CollectionDocument extends BaseDocument {
  id: string;
  contract: string;
  contractSymbol: string;
  name: string;
  slug: string;
  image: string;
  community: string;
  tokenCount: number;
  metadataDisabled: boolean;
  isSpam: boolean;
  isNsfw: boolean;
  imageVersion: number;
  day1Rank?: number | null;
  day1Volume?: string;
  day1VolumeDecimal?: number | null;
  day1VolumeUsd?: number;
  day7Rank?: number | null;
  day7Volume?: string;
  day7VolumeDecimal?: number | null;
  day7VolumeUsd?: number;
  day30Rank?: number | null;
  day30Volume?: string;
  day30VolumeDecimal?: number | null;
  day30VolumeUsd?: number;
  allTimeRank?: number | null;
  allTimeVolume?: string;
  allTimeVolumeDecimal?: number | null;
  allTimeVolumeUsd?: number;
  algoVolumeDecimal?: number | null;
  algoVolumeUsd?: number;
  floorSell?: {
    id?: string;
    value?: string;
    currency?: string;
    currencyPrice?: string;
  };
  openseaVerificationStatus?: string;
  magicedenVerificationStatus?: string;
}

export interface BuildCollectionDocumentData extends BuildDocumentData {
  id: string;
  contract: Buffer;
  contract_symbol: string;
  name: string;
  slug: string;
  image: string;
  image_version?: number;
  created_at: Date;
  community: string;
  token_count: number;
  metadata_disabled: number;
  is_spam: number;
  nsfw_status: number;
  day1_rank: number;
  day7_rank: number;
  day30_rank: number;
  all_time_rank: number;
  day1_volume: string;
  day7_volume: string;
  day30_volume: string;
  all_time_volume: string;
  floor_sell_id?: string;
  floor_sell_value?: string;
  floor_sell_currency?: Buffer;
  floor_sell_currency_price?: string;
  opensea_verification_status?: string;
  magiceden_verification_status?: string;
}

export class CollectionDocumentBuilder {
  public async buildDocument(data: BuildCollectionDocumentData): Promise<CollectionDocument> {
    try {
      const day1VolumeUsd = await getUsdPrice(data.day1_volume);
      const day7VolumeUsd = await getUsdPrice(data.day7_volume);
      const day30VolumeUsd = await getUsdPrice(data.day30_volume);
      const allTimeVolumeUsd = await getUsdPrice(data.all_time_volume);

      const day1VolumeDecimal = data.day1_volume ? formatEth(data.day1_volume) : 0;
      const day7VolumeDecimal = data.day7_volume ? formatEth(data.day7_volume) : 0;
      const day30VolumeDecimal = data.day30_volume ? formatEth(data.day30_volume) : 0;
      const allTimeVolumeDecimal = data.all_time_volume ? formatEth(data.all_time_volume) : 0;

      const document = {
        chain: {
          id: config.chainId,
          name: getChainName(),
        },
        chainId: String(config.chainId),
        id: data.id,
        indexedAt: new Date(),
        createdAt: data.created_at,
        contract: fromBuffer(data.contract),
        contractSymbol: data.contract_symbol,
        name: data.name?.trim(),
        suggestV2: this.getSuggest(data),
        suggestV3: this.getSuggestV3(data),
        slug: data.slug,
        image: data.image,
        imageVersion: data.image_version
          ? Math.floor(new Date(data.image_version).getTime() / 1000)
          : undefined,
        community: data.community,
        tokenCount: Number(data.token_count),
        metadataDisabled: Number(data.metadata_disabled) > 0,
        isSpam: Number(data.is_spam) > 0,
        isNsfw: Number(data.nsfw_status) > 0,
        day1Rank: data.day1_rank,
        day1Volume: data.day1_volume,
        day1VolumeDecimal: data.day1_volume ? formatEth(data.day1_volume) : null,
        day1VolumeUsd: day1VolumeUsd,
        day7Rank: data.day7_rank,
        day7Volume: data.day7_volume,
        day7VolumeDecimal: data.day7_volume ? formatEth(data.day7_volume) : null,
        day7VolumeUsd: day7VolumeUsd,
        day30Rank: data.day30_rank,
        day30Volume: data.day30_volume,
        day30VolumeDecimal: data.day30_volume ? formatEth(data.day30_volume) : null,
        day30VolumeUsd: day30VolumeUsd,
        allTimeRank: data.all_time_rank,
        allTimeVolume: data.all_time_volume,
        allTimeVolumeDecimal: data.all_time_volume ? formatEth(data.all_time_volume) : null,
        allTimeVolumeUsd: allTimeVolumeUsd,
        algoVolumeDecimal:
          day1VolumeDecimal * 0.3 +
          day7VolumeDecimal * 0.2 +
          day30VolumeDecimal * 0.06 +
          allTimeVolumeDecimal * 0.04,
        floorSell: data.floor_sell_id
          ? {
              id: data.floor_sell_id,
              value: data.floor_sell_value,
              currency: data.floor_sell_currency ? fromBuffer(data.floor_sell_currency) : undefined,
              currencyPrice: data.floor_sell_currency_price,
            }
          : undefined,
        openseaVerificationStatus: data.opensea_verification_status,
        magicedenVerificationStatus: data.magiceden_verification_status,
      } as CollectionDocument;

      return document;
    } catch (error) {
      logger.error(
        "CollectionDocumentBuilder",
        JSON.stringify({
          message: `buildDocument Error. collectionId=${data.id}, error=${error}`,
          data,
          error,
        })
      );

      throw error;
    }
  }

  getSuggest(data: BuildCollectionDocumentData): any {
    const day1VolumeDecimal = data.day1_volume ? formatEth(data.day1_volume) : 0;
    const day7VolumeDecimal = data.day7_volume ? formatEth(data.day7_volume) : 0;
    const day30VolumeDecimal = data.day30_volume ? formatEth(data.day30_volume) : 0;
    const allTimeVolumeDecimal = data.all_time_volume ? formatEth(data.all_time_volume) : 0;

    let weight =
      day1VolumeDecimal * 0.3 +
      day7VolumeDecimal * 0.2 +
      day30VolumeDecimal * 0.06 +
      allTimeVolumeDecimal * 0.04;

    if (weight > 0) {
      if (Number.isInteger(weight)) {
        weight += 1;
      } else {
        weight = Math.ceil(weight);
      }
    }

    const suggest = [];

    if (data.name) {
      suggest.push({
        input: this.generateInputValues(data),
        weight,
        contexts: {
          filters: [
            `${config.chainId}`,
            `*|${Number(data.is_spam) > 0}`,
            `${config.chainId}|${Number(data.is_spam) > 0}`,
          ],
        },
      });
    }

    if (data.contract_symbol) {
      suggest.push({
        input: [data.contract_symbol],
        weight,
        contexts: {
          filters: [
            `${config.chainId}`,
            `*|${Number(data.is_spam) > 0}`,
            `${config.chainId}|${Number(data.is_spam) > 0}`,
          ],
        },
      });
    }

    return suggest;
  }

  getSuggestV3(data: BuildCollectionDocumentData): any {
    const day1VolumeDecimal = data.day1_volume ? formatEth(data.day1_volume) : 0;
    const day7VolumeDecimal = data.day7_volume ? formatEth(data.day7_volume) : 0;
    const day30VolumeDecimal = data.day30_volume ? formatEth(data.day30_volume) : 0;
    const allTimeVolumeDecimal = data.all_time_volume ? formatEth(data.all_time_volume) : 0;

    function normalize(volume: number) {
      // Change of base formula for log base 10
      const log10 = (x: number) => Math.log(x) / Math.log(10);
      const result = 1 / (1 + Math.exp(-log10(1 + volume)));

      return result;
    }

    const normalizedVolume =
      normalize(day1VolumeDecimal) * 0.3 +
      normalize(day7VolumeDecimal) * 0.2 +
      normalize(day30VolumeDecimal) * 0.06 +
      normalize(allTimeVolumeDecimal) * 0.04;

    const weight = Math.ceil(normalizedVolume * 1000000000);

    const suggest = [];

    const isVerified =
      data.opensea_verification_status === "verified" ||
      data.magiceden_verification_status === "verified";

    if (data.name) {
      suggest.push({
        input: this.generateInputValues(data),
        weight,
        contexts: {
          filters: [
            `${config.chainId}|*|*`,
            `${config.chainId}|*|${isVerified}`,
            `${config.chainId}|${Number(data.is_spam) > 0}|*`,
            `${config.chainId}|${Number(data.is_spam) > 0}|${isVerified}`,
          ],
        },
      });
    }

    if (data.contract_symbol) {
      suggest.push({
        input: [data.contract_symbol],
        weight,
        contexts: {
          filters: [
            `${config.chainId}|*|*`,
            `${config.chainId}|*|${isVerified}`,
            `${config.chainId}|${Number(data.is_spam) > 0}|*`,
            `${config.chainId}|${Number(data.is_spam) > 0}|${isVerified}`,
          ],
        },
      });
    }

    return suggest;
  }

  generateInputValues(data: BuildCollectionDocumentData): string[] {
    const words = data.name.trim().split(" ");
    const combinations: string[] = [];

    for (let i = 0; i < words.length; i++) {
      const combination = words.slice(i).join(" ");
      combinations.push(combination);
    }

    return combinations;
  }
}
