/* eslint-disable @typescript-eslint/no-explicit-any */
import _ from "lodash";

import { rateLimitRedis, redis } from "@/common/redis";
import { idb, redb } from "@/common/db";
import {
  RateLimitRuleEntity,
  RateLimitRuleEntityParams,
  RateLimitRuleOptions,
  RateLimitRulePayload,
  RateLimitRuleUpdateParams,
} from "@/models/rate-limit-rules/rate-limit-rule-entity";
import { AllChainsChannel, Channel } from "@/pubsub/channels";
import { logger } from "@/common/logger";
import { ApiKeyManager } from "@/models/api-keys";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { BlockedKeyError, BlockedRouteError } from "@/models/rate-limit-rules/errors";
import { config } from "@/config/index";
import { AllChainsPubSub, PubSub } from "@/pubsub/index";
import Hapi from "@hapi/hapi";

export class RateLimitRules {
  private static instance: RateLimitRules;

  public rulesEntities: Map<string, RateLimitRuleEntity[]>; // Map of route to local DB rules entities
  public rules: Map<number, RateLimiterRedis>; // Map of rule ID to rate limit redis object
  public apiRoutesRegexRulesCache: Map<string, RateLimitRuleEntity[]>; // Local cache of matching regex rules per route to avoid redundant iterations and regex matching

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {
    this.rulesEntities = new Map();
    this.rules = new Map();
    this.apiRoutesRegexRulesCache = new Map();
  }

  private async loadData(forceDbLoad = false) {
    // Try to load from cache
    const rulesCache = await redis.get(RateLimitRules.getCacheKey());
    let rulesRawData: RateLimitRuleEntityParams[] = [];

    if (_.isNull(rulesCache) || forceDbLoad) {
      // If no cache load from DB
      try {
        const rulesQuery = `
          SELECT *
          FROM rate_limit_rules
          ORDER BY route DESC, api_key DESC, payload DESC, method DESC, tier DESC NULLS LAST
        `;

        rulesRawData = await redb.manyOrNone(rulesQuery);
      } catch (error) {
        logger.error("rate-limit-rules", "Failed to load rate limit rules");
      }

      await redis.set(
        RateLimitRules.getCacheKey(),
        JSON.stringify({ rulesRawData }),
        "EX",
        60 * 60 * 24
      );
    } else {
      // Parse the cache data
      const parsedRulesCache = JSON.parse(rulesCache);
      rulesRawData = parsedRulesCache.rulesRawData;
    }

    const rulesEntities = new Map<string, RateLimitRuleEntity[]>(); // Reset current rules entities
    const rules = new Map(); // Reset current rules

    // Parse rules data
    for (const rule of rulesRawData) {
      const rateLimitRule = new RateLimitRuleEntity(rule);

      if (rulesEntities.has(rateLimitRule.route)) {
        rulesEntities.get(rateLimitRule.route)?.push(rateLimitRule);
      } else {
        rulesEntities.set(rateLimitRule.route, [rateLimitRule]);
      }

      rules.set(
        rateLimitRule.id,
        new RateLimiterRedis({
          storeClient: rateLimitRedis,
          points: rateLimitRule.options.points,
          duration: rateLimitRule.options.duration,
          inMemoryBlockOnConsumed: rateLimitRule.options.points,
        })
      );
    }

    this.rulesEntities = rulesEntities;
    this.rules = rules;
    this.apiRoutesRegexRulesCache = new Map();
  }

  public static getCacheKey() {
    return "rate-limit-rules";
  }

  public static async forceDataReload() {
    if (RateLimitRules.instance) {
      await RateLimitRules.instance.loadData(true);
    }
  }

  public static async getInstance(forceDbLoad = false) {
    if (!this.instance) {
      this.instance = new RateLimitRules();
      await this.instance.loadData(forceDbLoad);
    }

    return this.instance;
  }

  public static async create(
    route: string,
    apiKey: string,
    method: string,
    tier: number | null,
    options: RateLimitRuleOptions,
    payload: RateLimitRulePayload[],
    correlationId = ""
  ) {
    const query = `INSERT INTO rate_limit_rules (route, api_key, method, tier, options, payload${
      correlationId ? ", correlation_id" : ""
    })
                   VALUES ($/route/, $/apiKey/, $/method/, $/tier/, $/options:json/, $/payload:json/${
                     correlationId ? ", $/correlationId/" : ""
                   })
                   RETURNING *`;

    const values = {
      route,
      apiKey,
      method,
      tier,
      options,
      payload,
      correlationId,
    };

    const rateLimitRule = await idb.oneOrNone(query, values);
    const rateLimitRuleEntity = new RateLimitRuleEntity(rateLimitRule);

    await RateLimitRules.forceDataReload(); // reload the cache
    await PubSub.publish(
      Channel.RateLimitRuleUpdated,
      `New rate limit rule ${JSON.stringify(rateLimitRuleEntity)}`
    );

    // Sync to other chains only if created on mainnet
    if (config.chainId === 1) {
      await AllChainsPubSub.publish(
        AllChainsChannel.RateLimitRuleCreated,
        JSON.stringify({ rule: rateLimitRuleEntity })
      );
    }

    logger.info(
      "rate-limit-rules",
      `New rate limit rule ${JSON.stringify(rateLimitRuleEntity)} was created`
    );

    return rateLimitRuleEntity;
  }

  public static async updateByCorrelationId(
    correlationId: string,
    fields: RateLimitRuleUpdateParams
  ) {
    const rateLimitRuleEntity = await RateLimitRules.getRuleByCorrelationId(correlationId);
    if (rateLimitRuleEntity) {
      await RateLimitRules.update(rateLimitRuleEntity.id, fields);
    }
  }

  public static async update(id: number, fields: RateLimitRuleUpdateParams) {
    let updateString = "";
    let jsonBuildObject = "";

    const replacementValues = {
      id,
    };

    _.forEach(fields, (param, fieldName) => {
      if (["id", "createdAt"].includes(fieldName)) {
        return;
      }

      if (fieldName === "options") {
        _.forEach(fields.options, (value, key) => {
          if (!_.isUndefined(value)) {
            jsonBuildObject += `'${key}', $/${key}/,`;
            (replacementValues as any)[key] = value;
          }
        });

        jsonBuildObject = _.trimEnd(jsonBuildObject, ",");

        if (jsonBuildObject !== "") {
          updateString += `options = options || jsonb_build_object (${jsonBuildObject}),`;
        }
      } else if (!_.isUndefined(param)) {
        updateString += `${_.snakeCase(fieldName)} = $/${fieldName}${
          _.includes(["payload"], fieldName) ? ":json" : ""
        }/,`;
        (replacementValues as any)[fieldName] = param;
      }
    });

    updateString = _.trimEnd(updateString, ",");

    const query = `UPDATE rate_limit_rules
                   SET ${updateString}
                   WHERE id = $/id/`;

    await idb.none(query, replacementValues);
    await PubSub.publish(Channel.RateLimitRuleUpdated, `Updated rule id ${id}`);

    // Sync to other chains only if updated on mainnet
    if (config.chainId === 1) {
      const rateLimitRuleEntity = await RateLimitRules.getRuleById(id);

      await AllChainsPubSub.publish(
        AllChainsChannel.RateLimitRuleUpdated,
        JSON.stringify({ rule: rateLimitRuleEntity })
      );
    }
  }

  public static async getRuleById(id: number) {
    const ruleQuery = `
          SELECT *
          FROM rate_limit_rules
          WHERE id = $/id/
        `;

    const rateLimitRule = await idb.oneOrNone(ruleQuery, { id });

    if (rateLimitRule) {
      return new RateLimitRuleEntity(rateLimitRule);
    }

    return null;
  }

  public static async getRuleByCorrelationId(correlationId: string) {
    const ruleQuery = `
          SELECT *
          FROM rate_limit_rules
          WHERE correlation_id = $/correlationId/
        `;

    const rateLimitRule = await idb.oneOrNone(ruleQuery, { correlationId });

    if (rateLimitRule) {
      return new RateLimitRuleEntity(rateLimitRule);
    }

    return null;
  }

  public static async deleteByCorrelationId(correlationId: string) {
    const rateLimitRuleEntity = await RateLimitRules.getRuleByCorrelationId(correlationId);
    if (rateLimitRuleEntity) {
      await RateLimitRules.delete(rateLimitRuleEntity.id);
    }
  }

  public static async delete(id: number) {
    const query = `DELETE FROM rate_limit_rules
                   WHERE id = $/id/
                   RETURNING correlation_id`;

    const values = {
      id,
    };

    const deletedRule = await idb.oneOrNone(query, values);
    await RateLimitRules.forceDataReload(); // reload the cache
    await PubSub.publish(Channel.RateLimitRuleUpdated, `Deleted rule id ${id}`);

    // Sync to other chains only if deleted on mainnet
    if (config.chainId === 1) {
      await AllChainsPubSub.publish(
        AllChainsChannel.RateLimitRuleDeleted,
        JSON.stringify({ correlationId: deletedRule.correlation_id })
      );
    }
  }

  public static async getApiKeyRateLimits(key: string) {
    const apiKey = await ApiKeyManager.getApiKey(key);
    const tier = _.max([apiKey?.tier || 0, 0]);

    const query = `SELECT DISTINCT ON (route) *
                   FROM rate_limit_rules
                   WHERE (tier = $/tier/ AND api_key IN ('', $/key/))
                   OR (tier IS NULL AND api_key IN ('', $/key/))
                   OR (api_key = $/key/)
                   ORDER BY route, api_key DESC`;

    const values = {
      tier,
      key,
    };

    const rules: RateLimitRuleEntityParams[] = await redb.manyOrNone(query, values);
    return _.map(rules, (rule) => new RateLimitRuleEntity(rule));
  }

  public findMostMatchingRule(
    route: string,
    method: string,
    tier: number,
    apiKey = "",
    payload: Map<string, string> = new Map(),
    apiTags: string[] = []
  ) {
    // If no cached regex rules
    if (!this.apiRoutesRegexRulesCache.get(route)) {
      let rules: RateLimitRuleEntity[] = [];

      for (const key of this.rulesEntities.keys()) {
        if (key !== "/" && route.match(key)) {
          rules = rules.concat(this.rulesEntities.get(key) ?? []);
        }
      }

      this.apiRoutesRegexRulesCache.set(route, rules); // Cache the regex rules for the given route
    }

    // Build an array of rules, specific route rules first, regex rules second, so they will be evaluated in that order
    const rulesToEvaluate = (this.rulesEntities.get(route) ?? []).concat(
      this.apiRoutesRegexRulesCache.get(route) ?? []
    );

    if (!_.isEmpty(rulesToEvaluate)) {
      for (const rule of rulesToEvaluate) {
        // Check what criteria to check for the rule
        const verifyApiKey = rule.apiKey !== "";
        const verifyPayload = !_.isEmpty(rule.payload);
        const verifyMethod = rule.method !== "";
        const verifyTier = !_.isNull(rule.tier);
        const verifyTag = !_.isEmpty(rule.options.apiTag);

        // Check the rule criteria, if none are not matching the rule is not matching
        if (verifyApiKey && rule.apiKey !== apiKey) {
          continue;
        }

        if (verifyPayload && !this.isPayloadMatchRulePayload(rule, payload)) {
          continue;
        }

        if (verifyMethod && rule.method !== method) {
          continue;
        }

        if (verifyTier && rule.tier !== tier) {
          continue;
        }

        if (verifyTag && rule.options.apiTag && !apiTags.includes(rule.options.apiTag)) {
          continue;
        }

        // If we reached here the rule is matching
        return rule;
      }
    }

    // No matching rule found, return default rules
    return this.getTierDefaultRule(tier, apiTags);
  }

  public isPayloadMatchRulePayload(rule: RateLimitRuleEntity, payload: Map<string, string>) {
    // If rule needs payload verification all params need to match
    for (const rulePayload of rule.payload) {
      const [rulePayloadKey] = rulePayload.key.split(".");

      // If the request consists any of the keys in the request and the value match
      if (
        !payload.has(rulePayloadKey) ||
        (rulePayload.value !== "*" &&
          rulePayload.value !== "?" &&
          _.toLower(payload.get(rulePayloadKey)) !== _.toLower(rulePayload.value))
      ) {
        return false;
      }
    }

    return true;
  }

  public getTierDefaultRule(tier: number, apiTags: string[]) {
    // No matching rule found, return default rules
    const defaultRules = this.rulesEntities.get("/") || [];

    // Evaluate first default rules with tags
    for (const rule of _.sortBy(defaultRules, (r) => r.options.apiTag)) {
      const verifyTag = !_.isEmpty(rule.options.apiTag);

      if (verifyTag && rule.options.apiTag && !apiTags.includes(rule.options.apiTag)) {
        continue;
      }

      if (rule.tier === tier) {
        return rule;
      }
    }
  }

  public getPayloadKeyPrefix(rule: RateLimitRuleEntity, payload: Map<string, string> = new Map()) {
    let keyPrefix = "";
    for (const rulePayload of rule.payload) {
      const rulePayloadArray = rulePayload.key.split(".");

      // If the rule is for nested payload
      if (
        rulePayloadArray.length > 1 &&
        rulePayload.value === "?" &&
        payload.has(rulePayloadArray[0])
      ) {
        // Get the first value from the map
        let currentValue = payload.get(rulePayloadArray[0]);

        // Iterate the rest of the payload assuming it is either an array or object
        for (const rulePayloadKey of _.drop(rulePayloadArray, 1)) {
          // In case of array grab the first item
          if (_.isArray(currentValue)) {
            if (_.isEmpty(currentValue)) {
              continue;
            }

            currentValue = currentValue[0];
          }

          if (currentValue && _.isObject(currentValue) && _.has(currentValue, rulePayloadKey)) {
            currentValue = currentValue[rulePayloadKey];
          }
        }

        keyPrefix += `:${currentValue}`.toLowerCase();
      }

      // If the rule is for param at the root payload
      if (
        rulePayloadArray.length === 1 &&
        rulePayload.value === "?" &&
        payload.has(rulePayload.key)
      ) {
        keyPrefix += `:${payload.get(rulePayloadArray[0])}`.toLowerCase();
      }
    }

    return keyPrefix;
  }

  public getRateLimitObject(
    request: Hapi.Request<Hapi.ReqRefDefaults>,
    tier: number,
    apiKey = "",
    payload: Map<string, string> = new Map()
  ): { ruleParams: RateLimitRuleEntity; rule: RateLimiterRedis; pointsToConsume: number } | null {
    const route = request.route.path;
    const method = request.route.method;
    const apiTags = request.route.settings.tags ?? [];

    if (tier < 0) {
      throw new BlockedKeyError(RateLimitRuleEntity.getRateLimitMessage(apiKey, tier));
    }

    const rule = this.findMostMatchingRule(route, method, tier, apiKey, payload, apiTags);

    if (rule) {
      // If the route is blocked
      if (rule.options.points === -1) {
        throw new BlockedRouteError(`Request to ${route} is currently suspended`);
      }

      const rateLimitObject = this.rules.get(rule.id);
      const pointsToConsume = rule.options.pointsToConsume || 1;

      if (rateLimitObject) {
        rateLimitObject.keyPrefix = `${config.chainId}:${
          rule.id
        }:${route}${this.getPayloadKeyPrefix(rule, payload)}`;

        // If no points defined for the rule take tier default points
        if (_.isUndefined(rule.options.points)) {
          rateLimitObject.points = Number(this.getTierDefaultRule(tier, apiTags)?.options.points);
        }

        // If no duration defined for the rule take tier default duration
        if (_.isUndefined(rule.options.duration)) {
          rateLimitObject.duration = Number(
            this.getTierDefaultRule(tier, apiTags)?.options.duration
          );
        }

        return {
          ruleParams: rule,
          rule: rateLimitObject,
          pointsToConsume,
        };
      }
    }

    return null;
  }

  public getAllRules() {
    return RateLimitRules.instance.rulesEntities;
  }
}
