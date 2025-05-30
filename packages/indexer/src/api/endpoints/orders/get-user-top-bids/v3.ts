/* eslint-disable @typescript-eslint/no-explicit-any */

import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { redbAlt } from "@/common/db";
import { logger } from "@/common/logger";
import {
  buildContinuation,
  formatEth,
  fromBuffer,
  regex,
  splitContinuation,
  toBuffer,
} from "@/common/utils";
import { Sources } from "@/models/sources";
import { Assets, ImageSize } from "@/utils/assets";
import _ from "lodash";
import {
  getJoiPriceObject,
  getJoiSourceObject,
  JoiOrderCriteria,
  JoiPrice,
  JoiSource,
} from "@/common/joi";
import { Orders } from "@/utils/orders";
import { ContractSets } from "@/models/contract-sets";
import * as Boom from "@hapi/boom";
import { CollectionSets } from "@/models/collection-sets";
import { BigNumber } from "@ethersproject/bignumber";

const version = "v3";

export const getUserTopBidsV3Options: RouteOptions = {
  description: "User Top Bids",
  notes: "Return the top bids for the given user tokens",
  tags: ["api", "x-deprecated", "marketplace"],
  plugins: {
    "hapi-swagger": {
      order: 7,
    },
  },
  validate: {
    params: Joi.object({
      user: Joi.string()
        .lowercase()
        .pattern(/^0x[a-fA-F0-9]{40}$/)
        .description(
          "Filter to a particular user. Example: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00`"
        ),
    }),
    query: Joi.object({
      collection: Joi.alternatives(
        Joi.string().lowercase(),
        Joi.array().items(Joi.string().lowercase())
      ).description(
        "Filter to one or more collections. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63`"
      ),
      contractsSetId: Joi.string().lowercase().description("Filter to a particular contracts set."),
      community: Joi.string()
        .lowercase()
        .description("Filter to a particular community. Example: `artblocks`"),
      collectionsSetId: Joi.string()
        .lowercase()
        .description("Filter to a particular collection set."),
      optimizeCheckoutURL: Joi.boolean()
        .default(false)
        .description(
          "If true, urls will only be returned for optimized sources that support royalties."
        ),
      includeCriteriaMetadata: Joi.boolean()
        .default(true)
        .description("If true, criteria metadata is included in the response."),
      normalizeRoyalties: Joi.boolean()
        .default(false)
        .description("If true, prices will include missing royalties to be added on-top."),
      useNonFlaggedFloorAsk: Joi.boolean()
        .default(false)
        .description("If true, will return the collection non flagged floor ask events."),
      continuation: Joi.string().description(
        "Use continuation token to request next offset of items."
      ),
      sortBy: Joi.string()
        .valid("topBidValue", "dateCreated", "orderExpiry", "floorDifferencePercentage")
        .default("topBidValue")
        .description("Order of the items are returned in the response."),
      sortDirection: Joi.string().lowercase().valid("asc", "desc").default("desc"),
      limit: Joi.number()
        .integer()
        .min(1)
        .max(100)
        .default(20)
        .description("Amount of items returned in response."),
      sampleSize: Joi.number()
        .integer()
        .min(1000)
        .max(100000)
        .default(10000)
        .description("Amount of tokens considered."),
      displayCurrency: Joi.string()
        .lowercase()
        .pattern(regex.address)
        .description("Return result in given currency"),
    }).oxor("collection", "collectionsSetId"),
  },
  response: {
    schema: Joi.object({
      totalTokensWithBids: Joi.number(),
      totalAmount: Joi.number(),
      topBids: Joi.array().items(
        Joi.object({
          id: Joi.string(),
          price: JoiPrice,
          maker: Joi.string()
            .lowercase()
            .pattern(/^0x[a-fA-F0-9]{40}$/),
          createdAt: Joi.string(),
          validFrom: Joi.number().unsafe(),
          validUntil: Joi.number().unsafe(),
          floorDifferencePercentage: Joi.number().unsafe(),
          source: JoiSource.allow(null),
          feeBreakdown: Joi.array()
            .items(
              Joi.object({
                kind: Joi.string(),
                recipient: Joi.string().allow("", null),
                bps: Joi.number(),
              })
            )
            .allow(null),
          criteria: JoiOrderCriteria.allow(null),
          token: Joi.object({
            contract: Joi.string(),
            tokenId: Joi.string(),
            name: Joi.string().allow("", null),
            image: Joi.string().allow("", null),
            floorAskPrice: Joi.number().unsafe().allow(null),
            lastSalePrice: Joi.number().unsafe().allow(null),
            collection: Joi.object({
              id: Joi.string().allow(null),
              name: Joi.string().allow("", null),
              imageUrl: Joi.string().allow("", null),
              floorAskPrice: Joi.number().unsafe().allow(null),
            }),
          }),
        })
      ),
      continuation: Joi.string().allow(null),
    }).label(`getUserTopBids${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-user-top-bids-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const params = request.params as any;
    const query = request.query as any;
    let contractFilter = "";
    let collectionFilter = "";
    let communityFilter = "";
    let sortField = "top_bid_value";
    let offset = 0;

    // Set the user value for the query
    (query as any).user = toBuffer(params.user);

    switch (query.sortBy) {
      case "dateCreated":
        sortField = "order_created_at";
        break;

      case "orderExpiry":
        sortField = "top_bid_valid_until";
        break;

      case "floorDifferencePercentage":
        sortField = "floor_difference_percentage";
        break;

      case "topBidValue":
      default:
        break;
    }

    if (query.continuation) {
      offset = Number(splitContinuation(query.continuation));
    }

    if (query.collection || query.collectionsSetId) {
      if (query.collectionsSetId) {
        query.collectionsIds = await CollectionSets.getCollectionsIds(query.collectionsSetId);
        if (_.isEmpty(query.collectionsIds)) {
          throw Boom.badRequest(`No collections for collection set ${query.collectionsSetId}`);
        }

        collectionFilter = `AND id IN ($/collectionsIds:csv/)`;
      } else if (Array.isArray(query.collection)) {
        collectionFilter = `AND id IN ($/collection:csv/)`;
      } else {
        collectionFilter = `AND id = $/collection/`;
      }
    }

    if (query.community) {
      communityFilter = `AND community = $/community/`;
    }

    if (query.contractsSetId) {
      const contracts = await ContractSets.getContracts(query.contractsSetId);
      if (_.isEmpty(contracts)) {
        throw Boom.badRequest(`No contracts for contracts set ${query.collectionsSetId}`);
      }

      query.contracts = contracts.map((contract: string) => toBuffer(contract));
      contractFilter = `AND contract IN ($/contracts:csv/)`;
    }

    try {
      const criteriaBuildQuery = Orders.buildCriteriaQuery(
        "y",
        "token_set_id",
        query.includeCriteriaMetadata,
        "token_set_schema_hash"
      );

      const collectionFloorSellValueColumnName = query.useNonFlaggedFloorAsk
        ? "non_flagged_floor_sell_value"
        : "floor_sell_value";

      const baseQuery = `
        WITH nb AS (
         SELECT contract, token_id, "owner", amount
         FROM nft_balances
         WHERE "owner" = $/user/
         AND amount > 0
         ${contractFilter}
         ORDER BY last_token_appraisal_value DESC NULLS LAST
         LIMIT ${query.sampleSize}
        )
        SELECT nb.contract, y.*, t.*, c.*, count(*) OVER() AS "total_tokens_with_bids", SUM(y.top_bid_price) OVER() as total_amount,
               (${criteriaBuildQuery}) AS bid_criteria,
               (CASE net_listing
                 WHEN 0 THEN NULL
                 ELSE COALESCE(((top_bid_value / net_listing) - 1) * 100, 0)
               END) AS floor_difference_percentage
        FROM nb
        JOIN LATERAL (
            SELECT o.token_set_id, o.id AS "top_bid_id", o.price AS "top_bid_price", o.value AS "top_bid_value",
                   o.currency AS "top_bid_currency", o.currency_price AS "top_bid_currency_price", o.currency_value AS "top_bid_currency_value", o.missing_royalties,
                   o.normalized_value AS "top_bid_normalized_value", o.currency_normalized_value AS "top_bid_currency_normalized_value",
                   o.maker AS "top_bid_maker", source_id_int, o.created_at "order_created_at", o.token_set_schema_hash,
                   extract(epoch from o.created_at) * 1000000 AS "order_created_at_micro",
                   DATE_PART('epoch', LOWER(o.valid_between)) AS "top_bid_valid_from", o.fee_breakdown,
                   COALESCE(
                     NULLIF(DATE_PART('epoch', UPPER(o.valid_between)), 'Infinity'),
                     0
                   ) AS "top_bid_valid_until"
            FROM orders o
            JOIN token_sets_tokens tst ON o.token_set_id = tst.token_set_id
            WHERE tst.contract = nb.contract
            AND tst.token_id = nb.token_id
            AND o.side = 'buy'
            AND o.fillability_status = 'fillable'
            AND o.approval_status = 'approved'
            AND o.maker != $/user/
            ${query.normalizeRoyalties ? " AND o.normalized_value IS NOT NULL" : ""}
            ORDER BY o.value DESC
            LIMIT 1
        ) y ON TRUE
        LEFT JOIN LATERAL (
            SELECT t.token_id, COALESCE(t.metadata_version::TEXT, t.image_version::TEXT) AS image_version, (t.metadata->>'image_mime_type') AS "image_mime_type", (t.metadata->>'media_mime_type') AS "media_mime_type",
            t.name, t.image, t.collection_id, floor_sell_value AS "token_floor_sell_value", last_sell_value AS "token_last_sell_value"
            FROM tokens t
            WHERE t.contract = nb.contract
            AND t.token_id = nb.token_id
        ) t ON TRUE
        ${
          query.collection || query.community || query.collectionsSetId ? "" : "LEFT"
        } JOIN LATERAL (
            SELECT
                id AS "collection_id",
                name AS "collection_name",
                metadata AS "collection_metadata",
                image_version AS "collection_image_version",
                ${collectionFloorSellValueColumnName} AS "collection_floor_sell_value",
                (${collectionFloorSellValueColumnName} * (1-((COALESCE(royalties_bps, 0)::float + 250) / 10000)))::numeric(78, 0) AS "net_listing"
            FROM collections c
            WHERE id = t.collection_id
            ${communityFilter}
            ${collectionFilter}
        ) c ON TRUE
        ORDER BY ${sortField} ${query.sortDirection}, token_id ${query.sortDirection}
        OFFSET ${offset} LIMIT $/limit/
      `;

      const sources = await Sources.getInstance();

      const bids = await redbAlt.manyOrNone(baseQuery, query);
      let totalTokensWithBids = 0;
      let totalAmount = BigNumber.from(0);

      const results = await Promise.all(
        bids.map(async (r) => {
          const contract = fromBuffer(r.contract);
          const tokenId = r.token_id;
          totalTokensWithBids = Number(r.total_tokens_with_bids);
          totalAmount = BigNumber.from(r.total_amount);

          const source = sources.get(
            Number(r.source_id_int),
            contract,
            tokenId,
            query.optimizeCheckoutURL
          );

          const feeBreakdown = r.fee_breakdown
            ? r.fee_breakdown?.map((f: any) => ({
                kind: f.kind,
                recipient: f.recipient,
                bps: f.bps,
              }))
            : [];

          if (query.normalizeRoyalties && r.missing_royalties) {
            for (let i = 0; i < r.missing_royalties.length; i++) {
              const index: number = r.fee_breakdown
                ? r.fee_breakdown.findIndex(
                    (fee: { recipient: string }) =>
                      fee.recipient === r.missing_royalties[i].recipient
                  )
                : -1;

              if (index !== -1) {
                feeBreakdown[index].bps += r.missing_royalties[i].bps;
              } else {
                feeBreakdown.push({
                  bps: r.missing_royalties[i].bps,
                  kind: "royalty",
                  recipient: r.missing_royalties[i].recipient,
                });
              }
            }
          }

          return {
            id: r.top_bid_id,
            price: await getJoiPriceObject(
              {
                net: {
                  amount: query.normalizeRoyalties
                    ? r.top_bid_currency_normalized_value ?? r.top_bid_value
                    : r.top_bid_currency_value ?? r.top_bid_value,
                  nativeAmount: query.normalizeRoyalties
                    ? r.top_bid_normalized_value ?? r.top_bid_value
                    : r.top_bid_value,
                },
                gross: {
                  amount: r.top_bid_currency_price ?? r.top_bid_price,
                  nativeAmount: r.top_bid_price,
                },
              },
              fromBuffer(r.top_bid_currency),
              query.displayCurrency
            ),
            maker: fromBuffer(r.top_bid_maker),
            createdAt: new Date(r.order_created_at).toISOString(),
            validFrom: r.top_bid_valid_from,
            validUntil: r.top_bid_valid_until,
            floorDifferencePercentage: _.round(r.floor_difference_percentage || 0, 2),
            source: getJoiSourceObject(source),
            feeBreakdown,
            criteria: r.bid_criteria,
            token: {
              contract: contract,
              tokenId: tokenId,
              name: r.name,
              image: Assets.getResizedImageUrl(
                r.image,
                undefined,
                r.image_version,
                r.image_mime_type
              ),
              floorAskPrice: r.token_floor_sell_value ? formatEth(r.token_floor_sell_value) : null,
              lastSalePrice: r.token_last_sell_value ? formatEth(r.token_last_sell_value) : null,
              collection: {
                id: r.collection_id,
                name: r.collection_name,
                imageUrl: Assets.getResizedImageUrl(
                  r.collection_metadata?.imageUrl,
                  ImageSize.small,
                  r.collection_image_version
                ),
                floorAskPrice: r.collection_floor_sell_value
                  ? formatEth(r.collection_floor_sell_value)
                  : null,
              },
            },
          };
        })
      );

      let continuation: string | null = null;
      if (bids.length >= query.limit) {
        continuation = offset + query.limit;
      }

      return {
        totalAmount: formatEth(totalAmount),
        totalTokensWithBids,
        topBids: results,
        continuation: continuation ? buildContinuation(continuation.toString()) : undefined,
      };
    } catch (error) {
      logger.error(`get-user-top-bids-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
