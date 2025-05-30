/* eslint-disable @typescript-eslint/no-explicit-any */

import _ from "lodash";
import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { logger } from "@/common/logger";
import { formatEth } from "@/common/utils";
import { Assets } from "@/utils/assets";

import * as collectionsIndex from "@/elasticsearch/indexes/collections";

const version = "v1";

export const getCollectionSearchV1Options: RouteOptions = {
  cache: {
    privacy: "public",
    expiresIn: 10000,
  },
  description: "Search Collections (Cross Chain)",
  tags: ["api", "Collections", "marketplace"],
  plugins: {
    "hapi-swagger": {
      order: 3,
    },
  },
  validate: {
    query: Joi.object({
      chains: Joi.alternatives().try(
        Joi.array()
          .max(50)
          .items(Joi.number())
          .description("Array of chains. Max limit is 50. Example: `chains[0]: 1`"),
        Joi.number().description("Array of chains. Max limit is 50. Example: `chains[0]: 1`")
      ),
      prefix: Joi.string()
        .lowercase()
        .required()
        .description("Lightweight search for collections that match a string. Example: `bored`"),
      community: Joi.string()
        .lowercase()
        .description("Filter to a particular community. Example: `artblocks`"),
      excludeSpam: Joi.boolean()
        .default(false)
        .description("If true, will filter any collections marked as spam."),
      excludeNsfw: Joi.boolean()
        .default(false)
        .description("If true, will filter any collections marked as nsfw."),
      limit: Joi.number()
        .integer()
        .min(1)
        .max(100)
        .default(20)
        .description("Amount of items returned in response."),
    }),
  },
  response: {
    schema: Joi.object({
      collections: Joi.array().items(
        Joi.object({
          chainId: Joi.number(),
          id: Joi.string(),
          contract: Joi.string(),
          image: Joi.string().allow("", null),
          name: Joi.string().allow("", null),
          tokenCount: Joi.string(),
          isSpam: Joi.boolean().default(false),
          slug: Joi.string().allow("", null),
          allTimeVolume: Joi.number().unsafe().allow(null),
          floorAskPrice: Joi.number().unsafe().allow(null),
          openseaVerificationStatus: Joi.string().allow("", null),
        })
      ),
    }).label(`getCollectionSearch${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-collection-search-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const query = request.query as any;

    if (query.chains && !_.isArray(query.chains)) {
      query.chains = [query.chains];
    }

    const { collections } = await collectionsIndex.autocompleteCrosschain({
      chains: query.chains,
      prefix: query.prefix,
      communities: query.community ? [query.community] : undefined,
      excludeSpam: query.excludeSpam,
      excludeNsfw: query.excludeNsfw,
      limit: query.limit,
    });

    const result = _.map(collections, async (collection) => {
      return {
        chainId: collection.chainId ? Number(collection.chainId) : collection.chain?.id,
        id: collection.id,
        name: collection.name,
        contract: collection.contract,
        image: Assets.getResizedImageURLs(collection.image),
        tokenCount: String(collection.tokenCount),
        allTimeVolume: collection.allTimeVolume ? formatEth(collection.allTimeVolume) : null,
        floorAskPrice: collection.floorSell?.value ? formatEth(collection.floorSell.value) : null,
        openseaVerificationStatus: collection.openseaVerificationStatus,
      };
    });

    return { collections: await Promise.all(result) };
  },
};
