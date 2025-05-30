import _ from "lodash";

import { idb, redb } from "@/common/db";
import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { fromBuffer, toBuffer } from "@/common/utils";
import {
  FeeKind,
  FeeRecipientEntity,
  FeeRecipientEntityParams,
} from "@/models/fee-recipients/fee-recipient-entity";
import { Sources } from "@/models/sources";
import { PubSub } from "@/pubsub/index";
import { Channel } from "@/pubsub/channels";

import { default as entitiesFromJson } from "@/models/fee-recipients/feeRecipients.json";

export class FeeRecipients {
  private static instance: FeeRecipients;

  public feeRecipientsByAddress: { [address: string]: FeeRecipientEntity };

  private constructor() {
    this.feeRecipientsByAddress = {};
  }

  private async loadData(forceDbLoad = false) {
    // Try to load from cache
    const entitiesCache = await redis.get(FeeRecipients.getCacheKey());
    let entities: FeeRecipientEntityParams[];

    if (_.isNull(entitiesCache) || forceDbLoad) {
      // If no cache is available, then load from the database
      entities = (
        await idb.manyOrNone(
          `
            SELECT
              fee_recipients.source_id,
              fee_recipients.kind,
              fee_recipients.address
            FROM fee_recipients
            WHERE is_deleted = 0
          `
        )
      ).map((c) => {
        return {
          ...c,
          address: fromBuffer(c.address),
        };
      });

      await redis.set(FeeRecipients.getCacheKey(), JSON.stringify(entities), "EX", 60 * 60 * 24);
    } else {
      // Parse the data
      entities = JSON.parse(entitiesCache);
    }

    for (const entity of entities) {
      const keyId = `${_.toLower(entity.address)}:${entity.kind}`;
      this.feeRecipientsByAddress[keyId] = new FeeRecipientEntity(entity);
    }
  }

  public static getCacheKey() {
    return "fee_recipients";
  }

  public static async getInstance() {
    if (!FeeRecipients.instance) {
      FeeRecipients.instance = new FeeRecipients();
      await FeeRecipients.instance.loadData();
    }

    return FeeRecipients.instance;
  }

  public static async forceDataReload() {
    if (FeeRecipients.instance) {
      await FeeRecipients.instance.loadData(true);
    }
  }

  public static async syncFeeRecipients() {
    // Make source the sources are loaded
    await Sources.getInstance();
    await Sources.forceDataReload();

    _.forEach(entitiesFromJson, (item) => {
      FeeRecipients.addFromJson(item.domain, item.address, item.kind as FeeKind);
    });
  }

  public static async addFromJson(domain: string | null, address: string, kind: FeeKind) {
    try {
      const source = await Sources.getInstance();
      const sourceId = domain ? source.getByDomain(domain)?.id : undefined;
      await idb.none(
        `
          INSERT INTO fee_recipients(
            address,
            source_id,
            kind
          ) VALUES (
            $/address/,
            $/sourceId/,
            $/kind/
          )
          ON CONFLICT (kind, address) DO UPDATE SET
            source_id = $/sourceId/
        `,
        {
          sourceId,
          kind,
          address: toBuffer(address),
        }
      );
    } catch (error) {
      // Ignore errors when loading from JSON
    }
  }

  public async create(address: string, kind: FeeKind, domain?: string | null) {
    let entity = await redb.oneOrNone(
      `
        SELECT
          *
        FROM fee_recipients
        WHERE address = $/address/
        AND kind = $/kind/
        AND is_deleted = 0
      `,
      {
        address: toBuffer(address),
        kind,
      }
    );

    if (entity) {
      return new FeeRecipientEntity(entity);
    }

    // THIS IS A DEBUG LOG Check if this address already exist but with different kind
    entity = await redb.oneOrNone(
      `
        SELECT
          *
        FROM fee_recipients
        WHERE address = $/address/
        AND is_deleted = 0
      `,
      {
        address: toBuffer(address),
      }
    );

    if (entity) {
      logger.warn(
        "fee-recipients",
        `address ${address} already exist recipient=${JSON.stringify(entity)} stack=${
          new Error().stack
        }`
      );

      return new FeeRecipientEntity(entity);
    }

    // Create the new fee recipient
    const source = await Sources.getInstance();
    const sourceId = domain ? source.getByDomain(domain)?.id : undefined;

    entity = await idb.oneOrNone(
      `
        INSERT INTO fee_recipients(
          address,
          source_id,
          kind
        ) VALUES (
          $/address/,
          $/sourceId/,
          $/kind/
        )
        ON CONFLICT (kind, address) DO UPDATE SET source_id = EXCLUDED.source_id
        RETURNING *
      `,
      {
        kind,
        address: toBuffer(address),
        sourceId,
      }
    );

    // Reload the cache
    await FeeRecipients.instance.loadData(true);

    await PubSub.publish(Channel.FeeRecipientsUpdated, `New fee-recipient ${address}:${kind}`);
    logger.info("fee-recipients", `New fee-recipient '${address}:${kind}' was added`);

    return new FeeRecipientEntity(entity);
  }

  public getByAddress(address: string, kind: FeeKind): FeeRecipientEntity | undefined {
    let entity: FeeRecipientEntity | undefined;

    address = _.toLower(address);
    const keyId = `${address}:${kind}`;
    if (keyId in this.feeRecipientsByAddress) {
      entity = this.feeRecipientsByAddress[keyId];
    }
    return entity;
  }

  public async getOrInsert(
    address: string,
    domain: string,
    kind: FeeKind
  ): Promise<FeeRecipientEntity> {
    let entity = this.getByAddress(address, kind);
    if (!entity) {
      entity = await this.create(address, kind, domain);
    }
    return entity;
  }

  public static async fixFeeRecipients(recipients: string[]) {
    try {
      const newRecipients = await idb.manyOrNone(
        `
          WITH "x" AS (
            UPDATE fee_recipients
            SET is_deleted = 1,
                updated_at = NOW()
            WHERE address IN ($/royaltiesRecipient:list/)
            AND is_deleted = 0
            AND kind = 'marketplace'
            RETURNING address, source_id
          )

          INSERT INTO fee_recipients(
              address,
              source_id,
              kind
          ) (
            SELECT address, source_id, 'royalty' AS kind
            FROM x
          )
          ON CONFLICT DO NOTHING
          RETURNING *
      `,
        {
          royaltiesRecipient: recipients.map(toBuffer),
        }
      );

      if (newRecipients.length) {
        // Reload the cache
        await FeeRecipients.instance.loadData(true);

        await PubSub.publish(
          Channel.FeeRecipientsUpdated,
          `New fee-recipients ${newRecipients.map((f) => `${fromBuffer(f.address)}:royalty`)}`
        );

        logger.info(
          "fee-recipients",
          `fee-recipients updated from marketplace to '${newRecipients.map(
            (f) => `${fromBuffer(f.address)}:royalty`
          )}'`
        );
      }
    } catch {
      // Ignore errors
    }
  }
}
