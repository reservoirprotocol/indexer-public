/* eslint-disable @typescript-eslint/no-explicit-any */
import { isAddress } from "@ethersproject/address";

import { elasticsearchCollections as elasticsearch } from "@/common/elasticsearch";
import { logger } from "@/common/logger";

import { CollectionDocument } from "@/elasticsearch/indexes/collections/base";

import { config } from "@/config/index";
import { isRetryableError } from "@/elasticsearch/indexes/utils";

const INDEX_NAME = config.elasticsearchCollectionsIndexName || `collections`;

export const save = async (collections: CollectionDocument[], upsert = true): Promise<void> => {
  try {
    const response = await elasticsearch.bulk({
      body: collections.flatMap((collection) => [
        { [upsert ? "index" : "create"]: { _index: INDEX_NAME, _id: collection.id } },
        collection,
      ]),
    });

    if (response.errors) {
      if (upsert) {
        logger.error(
          "elasticsearch-collections",
          JSON.stringify({
            topic: "save-errors",
            upsert,
            data: {
              collections: JSON.stringify(collections),
            },
            response,
          })
        );
      } else {
        logger.debug(
          "elasticsearch-collections",
          JSON.stringify({
            topic: "save-conflicts",
            upsert,
            data: {
              collections: JSON.stringify(collections),
            },
            response,
          })
        );
      }
    }
  } catch (error) {
    logger.error(
      "elasticsearch-collections",
      JSON.stringify({
        topic: "save",
        upsert,
        data: {
          collections: JSON.stringify(collections),
        },
        error,
      })
    );

    throw error;
  }
};
export const getIndexName = (): string => {
  return INDEX_NAME;
};
export const autocomplete = async (
  params: {
    prefix: string;
    collectionIds?: string[];
    communities?: string[];
    excludeSpam?: boolean;
    excludeNsfw?: boolean;
    fuzzy?: boolean;
    limit?: number;
  },
  retries = 0
): Promise<{ results: { collection: CollectionDocument; score: number }[] }> => {
  let esQuery = undefined;
  let esSuggest = undefined;

  try {
    if (isAddress(params.prefix)) {
      esQuery = {
        bool: {
          filter: [
            {
              term: { ["chain.id"]: config.chainId },
            },
            {
              term: { metadataDisabled: false },
            },
            {
              term: { contract: params.prefix },
            },
          ],
        },
      };

      if (params.collectionIds?.length) {
        const collections = params.collectionIds.map((collectionId) => collectionId.toLowerCase());

        (esQuery as any).bool.filter.push({
          terms: { "collection.id": collections },
        });
      }

      if (params.communities?.length) {
        const communities = params.communities?.map((community) => community.toLowerCase());

        (esQuery as any).bool.filter.push({
          terms: { community: communities },
        });
      }

      if (params.excludeSpam) {
        (esQuery as any).bool.filter.push({
          term: { isSpam: false },
        });
      }

      if (params.excludeNsfw) {
        (esQuery as any).bool.filter.push({
          term: { isNsfw: false },
        });
      }

      const esSearchParams = {
        index: INDEX_NAME,
        query: esQuery,
        size: params.limit,
      };

      const esResult = await elasticsearch.search<CollectionDocument>(esSearchParams);

      const results: { collection: CollectionDocument; score: number }[] = esResult.hits.hits.map(
        (hit) => {
          return { collection: hit._source!, score: hit._score! };
        }
      );

      return { results };
    } else {
      esSuggest = {
        prefix_suggestion: {
          prefix: params.prefix,
          completion: {
            field: "suggestV2",
            fuzzy: !!params.fuzzy,
            size: params.limit ?? 20,
            contexts: {
              filters: params.excludeSpam ? [`${config.chainId}|false`] : [`${config.chainId}`],
            },
          },
        },
      };

      const esSearchParams = {
        index: INDEX_NAME,
        suggest: esSuggest,
      };

      const esResult = await elasticsearch.search<CollectionDocument>(esSearchParams);

      const results: { collection: CollectionDocument; score: number }[] =
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        esResult.suggest?.prefix_suggestion[0].options.map((option: any) => {
          return { collection: option._source!, score: option._score! };
        });

      return { results };
    }
  } catch (error) {
    if (isRetryableError(error)) {
      logger.warn(
        "elasticsearch-collections",
        JSON.stringify({
          topic: "autocompleteCollections",
          message: "Retrying...",
          params,
          esQuery,
          esSuggest,
          error,
          retries,
        })
      );

      if (retries <= 3) {
        retries += 1;
        return autocomplete(params, retries);
      }

      logger.error(
        "elasticsearch-collections",
        JSON.stringify({
          topic: "autocompleteCollections",
          message: "Max retries reached.",
          params,
          esQuery,
          esSuggest,
          error,
          retries,
        })
      );

      throw new Error("Could not perform search.");
    } else {
      logger.error(
        "elasticsearch-collections",
        JSON.stringify({
          topic: "autocompleteCollections",
          message: "Unexpected error.",
          params,
          esQuery,
          esSuggest,
          error,
        })
      );
    }

    throw error;
  }
};

export const autocompleteV2 = async (
  params: {
    prefix: string;
    collectionIds?: string[];
    communities?: string[];
    excludeSpam?: boolean;
    excludeNsfw?: boolean;
    boostVerified?: boolean;
    fuzzy?: boolean;
    limit?: number;
  },
  retries = 0
): Promise<{ results: { collection: CollectionDocument; score: number }[] }> => {
  let esQuery = undefined;
  let esSuggest = undefined;

  try {
    if (isAddress(params.prefix)) {
      esQuery = {
        bool: {
          filter: [
            {
              term: { ["chain.id"]: config.chainId },
            },
            {
              term: { metadataDisabled: false },
            },
            {
              term: { contract: params.prefix },
            },
          ],
        },
      };

      if (params.collectionIds?.length) {
        const collections = params.collectionIds.map((collectionId) => collectionId.toLowerCase());

        (esQuery as any).bool.filter.push({
          terms: { "collection.id": collections },
        });
      }

      if (params.communities?.length) {
        const communities = params.communities?.map((community) => community.toLowerCase());

        (esQuery as any).bool.filter.push({
          terms: { community: communities },
        });
      }

      if (params.excludeSpam) {
        (esQuery as any).bool.filter.push({
          term: { isSpam: false },
        });
      }

      if (params.excludeNsfw) {
        (esQuery as any).bool.filter.push({
          term: { isNsfw: false },
        });
      }

      const esSearchParams = {
        index: INDEX_NAME,
        query: esQuery,
        size: params.limit,
      };

      const esResult = await elasticsearch.search<CollectionDocument>(esSearchParams);

      const results: { collection: CollectionDocument; score: number }[] = esResult.hits.hits.map(
        (hit) => {
          return { collection: hit._source!, score: hit._score! };
        }
      );

      return { results };
    } else {
      const filters = [];

      if (params.boostVerified) {
        if (params.excludeSpam) {
          filters.push({ context: `${config.chainId}|false|false`, boost: 1 });
          filters.push({ context: `${config.chainId}|false|true`, boost: 1000000000 });
        } else {
          filters.push({ context: `${config.chainId}|*|false`, boost: 1 });
          filters.push({ context: `${config.chainId}|*|true`, boost: 1000000000 });
        }
      } else if (params.excludeSpam) {
        filters.push({ context: `${config.chainId}|false|*`, boost: 1 });
      } else {
        filters.push({ context: `${config.chainId}|*|*`, boost: 1 });
      }

      esSuggest = {
        prefix_suggestion: {
          prefix: params.prefix,
          completion: {
            field: "suggestV3",
            fuzzy: !!params.fuzzy,
            size: params.limit ?? 20,
            contexts: {
              filters,
            },
          },
        },
      };

      const esSearchParams = {
        index: INDEX_NAME,
        suggest: esSuggest,
      };

      const esResult = await elasticsearch.search<CollectionDocument>(esSearchParams);

      const results: { collection: CollectionDocument; score: number }[] =
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        esResult.suggest?.prefix_suggestion[0].options.map((option: any) => {
          return { collection: option._source!, score: option._score! };
        });

      return { results };
    }
  } catch (error) {
    if (isRetryableError(error)) {
      logger.warn(
        "elasticsearch-collections",
        JSON.stringify({
          topic: "autocompleteCollections",
          message: "Retrying...",
          params,
          esQuery,
          esSuggest,
          error,
          retries,
        })
      );

      if (retries <= 3) {
        retries += 1;
        return autocomplete(params, retries);
      }

      logger.error(
        "elasticsearch-collections",
        JSON.stringify({
          topic: "autocompleteCollections",
          message: "Max retries reached.",
          params,
          esQuery,
          esSuggest,
          error,
          retries,
        })
      );

      throw new Error("Could not perform search.");
    } else {
      logger.error(
        "elasticsearch-collections",
        JSON.stringify({
          topic: "autocompleteCollections",
          message: "Unexpected error.",
          params,
          esQuery,
          esSuggest,
          error,
        })
      );
    }

    throw error;
  }
};

export const autocompleteCrosschain = async (params: {
  prefix: string;
  chains?: number[];
  communities?: string[];
  excludeSpam?: boolean;
  excludeNsfw?: boolean;
  limit?: number;
}): Promise<{ collections: CollectionDocument[] }> => {
  const esQuery = {
    bool: {
      must: {
        multi_match: {
          query: params.prefix,
          type: "bool_prefix",
          analyzer: "keyword",
          fields: ["name", "name._2gram", "name._3gram"],
        },
      },
      filter: [
        {
          range: { tokenCount: { gt: 0 } },
        },
      ],
    },
  };

  (esQuery as any).bool.filter.push({
    term: { metadataDisabled: false },
  });

  if (isAddress(params.prefix)) {
    (esQuery as any).bool.must.multi_match.fields.push("contract");
  }

  if (params.chains?.length) {
    const chains = params.chains?.map((chainId) => chainId);

    (esQuery as any).bool.filter.push({
      terms: { "chain.id": chains },
    });
  }

  if (params.communities?.length) {
    const communities = params.communities?.map((community) => community.toLowerCase());

    (esQuery as any).bool.filter.push({
      terms: { community: communities },
    });
  }

  if (params.excludeSpam) {
    (esQuery as any).bool.filter.push({
      term: { isSpam: false },
    });
  }

  if (params.excludeNsfw) {
    (esQuery as any).bool.filter.push({
      term: { isNsfw: false },
    });
  }

  try {
    const esSearchParams = {
      index: INDEX_NAME,
      query: esQuery,
      sort: [
        {
          allTimeVolumeUsd: {
            order: "desc",
          },
        },
        {
          _score: {
            order: "desc",
          },
        },
      ],
      size: params.limit,
    };

    const esResult = await elasticsearch.search<CollectionDocument>(esSearchParams);

    const collections: CollectionDocument[] = esResult.hits.hits.map((hit) => hit._source!);

    return { collections };
  } catch (error) {
    logger.error(
      "elasticsearch-collections",
      JSON.stringify({
        topic: "autocompleteCollections",
        data: {
          params: params,
        },
        error,
      })
    );

    throw error;
  }
};
