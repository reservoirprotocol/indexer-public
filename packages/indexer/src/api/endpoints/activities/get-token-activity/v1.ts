/* eslint-disable @typescript-eslint/no-explicit-any */

import _ from "lodash";
import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { logger } from "@/common/logger";
import { formatEth, regex } from "@/common/utils";
import { Sources } from "@/models/sources";
import { ActivityType } from "@/elasticsearch/indexes/activities/base";
import * as ActivitiesIndex from "@/elasticsearch/indexes/activities";
import { JoiSource, getJoiSourceObject } from "@/common/joi";
import { config } from "@/config/index";

const version = "v1";

export const getTokenActivityV1Options: RouteOptions = {
  description: "Token activity",
  notes: "This API can be used to build a feed for a token",
  tags: ["api", "x-deprecated", "marketplace"],
  plugins: {
    "hapi-swagger": {
      order: 1,
    },
  },
  validate: {
    params: Joi.object({
      token: Joi.string()
        .lowercase()
        .pattern(regex.token)
        .description(
          "Filter to a particular token. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63:123`"
        )
        .required(),
    }),
    query: Joi.object({
      limit: Joi.number()
        .integer()
        .min(1)
        .max(20)
        .default(20)
        .description("Amount of items returned in response."),
      continuation: Joi.number().description(
        "Use continuation token to request next offset of items."
      ),
      types: Joi.alternatives()
        .try(
          Joi.array().items(
            Joi.string()
              .lowercase()
              .valid(
                ActivityType.nftAsk,
                ActivityType.nftBid,
                ActivityType.nftMint,
                ActivityType.nftSale,
                ActivityType.nftAskCancel,
                ActivityType.nftBidCancel,
                ActivityType.nftTransfer
              )
          ),
          Joi.string()
            .lowercase()
            .valid(
              ActivityType.nftAsk,
              ActivityType.nftBid,
              ActivityType.nftMint,
              ActivityType.nftSale,
              ActivityType.nftAskCancel,
              ActivityType.nftBidCancel,
              ActivityType.nftTransfer
            )
        )
        .description("Types of events returned in response. Example: 'types=sale'"),
    }),
  },
  response: {
    schema: Joi.object({
      continuation: Joi.number().allow(null),
      activities: Joi.array().items(
        Joi.object({
          type: Joi.string(),
          fromAddress: Joi.string(),
          toAddress: Joi.string().allow(null),
          price: Joi.number().unsafe(),
          amount: Joi.number().unsafe(),
          timestamp: Joi.number(),
          token: Joi.object({
            tokenId: Joi.string().allow(null),
            tokenName: Joi.string().allow("", null),
            tokenImage: Joi.string().allow("", null),
          }),
          collection: Joi.object({
            collectionId: Joi.string().allow(null),
            collectionName: Joi.string().allow("", null),
            collectionImage: Joi.string().allow("", null),
          }),
          txHash: Joi.string().lowercase().pattern(regex.bytes32).allow(null),
          logIndex: Joi.number().allow(null),
          batchIndex: Joi.number().allow(null),
          source: JoiSource.allow(null),
        })
      ),
    }).label(`getTokenActivity${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-token-activity-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const params = request.params as any;
    const query = request.query as any;

    if (query.types && !_.isArray(query.types)) {
      query.types = [query.types];
    }

    if ((!query.types || query.types?.length === 0) && config.enableElasticsearchFtActivities) {
      query.types = [
        ActivityType.nftAsk,
        ActivityType.nftBid,
        ActivityType.nftMint,
        ActivityType.nftSale,
        ActivityType.nftAskCancel,
        ActivityType.nftBidCancel,
        ActivityType.nftTransfer,
      ];
    }

    try {
      const [contract, tokenId] = params.token.split(":");

      const sources = await Sources.getInstance();

      const { activities, continuation } = await ActivitiesIndex.search({
        types: query.types,
        tokens: [{ contract, tokenId }],
        sortBy: "timestamp",
        limit: query.limit,
        continuation: query.continuation,
        continuationAsInt: true,
      });

      const result = _.map(activities, (activity) => {
        const source = activity.order?.sourceId ? sources.get(activity.order.sourceId) : undefined;

        return {
          type: activity.type,
          fromAddress: activity.fromAddress,
          toAddress: activity.toAddress || null,
          price: formatEth(activity.pricing?.price || 0),
          amount: Number(activity.amount),
          timestamp: activity.timestamp,
          token: {
            tokenId: activity.token?.id,
            tokenName: activity.token?.name,
            tokenImage: activity.token?.image,
          },
          collection: {
            collectionId: activity.collection?.id,
            collectionName: activity.collection?.name,
            collectionImage:
              activity.collection?.image != null ? activity.collection?.image : undefined,
          },
          txHash: activity.event?.txHash,
          logIndex: activity.event?.logIndex,
          batchIndex: activity.event?.batchIndex,
          source: getJoiSourceObject(source, false),
        };
      });

      return {
        activities: result,
        continuation: continuation ? Number(continuation) : null,
      };
    } catch (error) {
      logger.error(`get-token-activity-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
