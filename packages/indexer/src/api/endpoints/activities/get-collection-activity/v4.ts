/* eslint-disable @typescript-eslint/no-explicit-any */

import _ from "lodash";
import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { logger } from "@/common/logger";
import { formatEth, regex } from "@/common/utils";
import { Sources } from "@/models/sources";
import { JoiOrderMetadata, JoiSource, getJoiSourceObject } from "@/common/joi";
import { ActivityType } from "@/elasticsearch/indexes/activities/base";
import * as ActivitiesIndex from "@/elasticsearch/indexes/activities";
import { CollectionSets } from "@/models/collection-sets";
import * as Boom from "@hapi/boom";
import { Collections } from "@/models/collections";
import { config } from "@/config/index";

const version = "v4";

export const getCollectionActivityV4Options: RouteOptions = {
  description: "Collection activity",
  notes: "This API can be used to build a feed for a collection",
  tags: ["api", "x-deprecated", "marketplace"],
  plugins: {
    "hapi-swagger": {
      order: 1,
    },
  },
  validate: {
    query: Joi.object({
      collection: Joi.string()
        .lowercase()
        .description(
          "Filter to a particular collection with collection-id. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63`"
        ),
      collectionsSetId: Joi.string()
        .lowercase()
        .description("Filter to a particular collection set."),
      community: Joi.string()
        .lowercase()
        .description("Filter to a particular community. Example: `artblocks`"),
      limit: Joi.number()
        .integer()
        .min(1)
        .default(20)
        .description(
          "Amount of items returned in response. If `includeMetadata=true` max limit is 20, otherwise max limit is 1,000."
        )
        .when("includeMetadata", {
          is: true,
          then: Joi.number().integer().max(20),
          otherwise: Joi.number().integer().max(1000),
        }),
      sortBy: Joi.string()
        .valid("eventTimestamp", "createdAt")
        .default("eventTimestamp")
        .description(
          "Order the items are returned in the response, eventTimestamp = The blockchain event time, createdAt - The time in which event was recorded"
        ),
      continuation: Joi.string().description(
        "Use continuation token to request next offset of items."
      ),
      includeMetadata: Joi.boolean()
        .default(true)
        .description("If true, metadata is included in the response."),
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
    }).xor("collection", "collectionsSetId", "community"),
  },
  response: {
    schema: Joi.object({
      continuation: Joi.string().allow(null),
      activities: Joi.array().items(
        Joi.object({
          type: Joi.string(),
          fromAddress: Joi.string(),
          toAddress: Joi.string().allow(null),
          price: Joi.number().unsafe(),
          amount: Joi.number().unsafe(),
          timestamp: Joi.number(),
          createdAt: Joi.string(),
          contract: Joi.string()
            .lowercase()
            .pattern(/^0x[a-fA-F0-9]{40}$/)
            .allow(null),
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
          order: Joi.object({
            id: Joi.string().allow(null),
            side: Joi.string().valid("ask", "bid").allow(null),
            source: JoiSource.allow(null),
            metadata: JoiOrderMetadata.allow(null).optional(),
          }),
        })
      ),
    }).label(`getCollectionActivity${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-collection-activity-${version}-handler`, `Wrong response schema: ${error}`);
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

    try {
      if (query.collection && !_.isArray(query.collection)) {
        query.collection = [query.collection];
      }

      if (query.collectionsSetId) {
        query.collection = await CollectionSets.getCollectionsIds(query.collectionsSetId);
        if (_.isEmpty(query.collection)) {
          throw Boom.badRequest(`No collections for collection set ${query.collectionsSetId}`);
        }
      }

      if (query.community) {
        query.collection = await Collections.getIdsByCommunity(query.community);

        if (query.collection.length === 0) {
          throw Boom.badRequest(`No collections for community ${query.community}`);
        }
      }

      const sources = await Sources.getInstance();

      const { activities, continuation } = await ActivitiesIndex.search({
        types: query.types,
        collections: query.collection,
        sortBy: query.sortBy === "eventTimestamp" ? "timestamp" : query.sortBy,
        limit: query.limit,
        continuation: query.continuation,
      });

      const result = _.map(activities, (activity) => {
        let order;

        if (query.includeMetadata) {
          const orderSource = activity.order?.sourceId
            ? sources.get(activity.order.sourceId)
            : undefined;

          let orderCriteria;

          if (activity.order?.criteria) {
            orderCriteria = {
              kind: activity.order.criteria.kind,
              data: {
                collectionName: activity.collection?.name,
                image:
                  activity.order.criteria.kind === "token"
                    ? activity.token?.image
                    : activity.collection?.image,
              },
            };

            if (activity.order.criteria.kind === "token") {
              (orderCriteria as any).data.tokenName = activity.token?.name;
            }

            if (activity.order.criteria.kind === "attribute") {
              (orderCriteria as any).data.attributes = [activity.order.criteria.data.attribute];
            }
          }

          order = activity.order?.id
            ? {
                id: activity.order.id,
                side: activity.order.side
                  ? activity.order.side === "sell"
                    ? "ask"
                    : "bid"
                  : undefined,
                source: getJoiSourceObject(orderSource, false),
                metadata: orderCriteria,
              }
            : undefined;
        } else {
          order = activity.order?.id
            ? {
                id: activity.order.id,
              }
            : undefined;
        }

        return {
          type: activity.type,
          fromAddress: activity.fromAddress,
          toAddress: activity.toAddress || null,
          price: formatEth(activity.pricing?.price || 0),
          amount: Number(activity.amount),
          timestamp: activity.timestamp,
          createdAt: new Date(activity.createdAt).toISOString(),
          contract: activity.contract,
          token: {
            tokenId: activity.token?.id || null,
            tokenName: query.includeMetadata ? activity.token?.name || null : undefined,
            tokenImage: query.includeMetadata ? activity.token?.image || null : undefined,
          },
          collection: {
            collectionId: activity.collection?.id,
            collectionName: query.includeMetadata ? activity.collection?.name : undefined,
            collectionImage:
              query.includeMetadata && activity.collection?.image != null
                ? activity.collection?.image
                : undefined,
          },
          txHash: activity.event?.txHash,
          logIndex: activity.event?.logIndex,
          batchIndex: activity.event?.batchIndex,
          order,
        };
      });

      return { activities: result, continuation };
    } catch (error) {
      logger.error(`get-collection-activity-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
