/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { logger } from "@/common/logger";
import { config } from "@/config/index";
import { ApiKeyManager } from "@/models/api-keys";
import { regex } from "@/common/utils";
import { OrderbookFees } from "@/models/api-keys/api-key-entity";
import _ from "lodash";
import { ORDERBOOK_FEE_ORDER_KINDS } from "@/utils/orderbook-fee";

export const postUpdateApiKeyOptions: RouteOptions = {
  description: "Update the given api key",
  tags: ["api", "x-admin"],
  validate: {
    headers: Joi.object({
      "x-admin-api-key": Joi.string().required(),
    }).options({ allowUnknown: true }),
    payload: Joi.object({
      apiKey: Joi.string().description("The api key to update"),
      tier: Joi.number().optional(),
      active: Joi.boolean().optional(),
      ips: Joi.array().items(Joi.string().lowercase().pattern(regex.ipv4)).optional(),
      origins: Joi.array().items(Joi.string().lowercase().pattern(regex.origin)).optional(),
      permissions: Joi.object({
        override_collection_refresh_cool_down: Joi.boolean().optional(),
        assign_collection_to_community: Joi.boolean().optional(),
        update_metadata_disabled: Joi.boolean().optional(),
        update_spam_status: Joi.boolean().optional(),
        update_nsfw_status: Joi.boolean().optional(),
        token_data_override: Joi.boolean().optional(),
        entity_data_override: Joi.boolean().optional(),
        invalidate_orders: Joi.boolean().optional(),
        set_collection_magiceden_verification_status: Joi.boolean().optional(),
      }).optional(),
      revShareBps: Joi.number().allow(null).optional(),
      orderbookFees: Joi.array()
        .items(
          Joi.object({
            orderbook: Joi.string()
              .valid(...ORDERBOOK_FEE_ORDER_KINDS)
              .required(),
            feeBps: Joi.number().allow(null).required(),
          })
        )
        .optional(),
      disableOrderbookFees: Joi.boolean().allow(null).optional(),
    }),
  },
  handler: async (request: Request) => {
    if (request.headers["x-admin-api-key"] !== config.adminApiKey) {
      throw Boom.unauthorized("Wrong or missing admin API key");
    }

    const payload = request.payload as any;
    let orderbookFees: OrderbookFees | undefined = undefined;

    if (payload.orderbookFees) {
      orderbookFees = {};
      for (const orderbookFee of payload.orderbookFees) {
        orderbookFees[orderbookFee.orderbook as (typeof ORDERBOOK_FEE_ORDER_KINDS)[number]] =
          _.isNull(orderbookFee.feeBps) ? null : { feeBps: orderbookFee.feeBps };
      }
    }

    try {
      await ApiKeyManager.update(payload.apiKey, {
        tier: payload.tier,
        active: payload.active,
        ips: payload.ips,
        origins: payload.origins,
        revShareBps: payload.revShareBps,
        permissions: payload.permissions,
        disableOrderbookFees: payload.disableOrderbookFees,
        orderbookFees,
      });

      return {
        message: `Api Key ${payload.apiKey} was updated with ${JSON.stringify(payload)}`,
      };
    } catch (error) {
      logger.error("post-update-api-key-handler", `Handler failure: ${error}`);
      throw error;
    }
  },
};
