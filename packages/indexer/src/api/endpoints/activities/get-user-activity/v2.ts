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

const version = "v2";

export const getUserActivityV2Options: RouteOptions = {
  description: "Users activity",
  notes: "This API can be used to build a feed for a user",
  tags: ["api", "x-deprecated", "marketplace"],
  plugins: {
    "hapi-swagger": {
      order: 1,
    },
  },
  validate: {
    query: Joi.object({
      users: Joi.alternatives()
        .try(
          Joi.array()
            .items(Joi.string().lowercase().pattern(regex.address))
            .min(1)
            .max(50)
            .description(
              "Array of users addresses. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63`"
            ),
          Joi.string()
            .lowercase()
            .pattern(regex.address)
            .description(
              "Array of users addresses. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63`"
            )
        )
        .required(),
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
    }).label(`getUserActivity${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-user-activity-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
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

    if (!_.isArray(query.users)) {
      query.users = [query.users];
    }

    try {
      const sources = await Sources.getInstance();

      const { activities, continuation } = await ActivitiesIndex.search({
        types: query.types,
        users: query.users,
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
            tokenId: activity.token?.id || null,
            tokenName: query.includeMetadata ? activity.token?.name || null : undefined,
            tokenImage: query.includeMetadata ? activity.token?.image || null : undefined,
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
      logger.error(`get-user-activity-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
