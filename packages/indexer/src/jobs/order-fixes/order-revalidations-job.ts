import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { toBuffer } from "@/common/utils";
import { AbstractRabbitMqJobHandler, BackoffStrategy } from "@/jobs/abstract-rabbit-mq-job-handler";
import {
  orderUpdatesByIdJob,
  OrderUpdatesByIdJobPayload,
} from "@/jobs/order-updates/order-updates-by-id-job";

export type OrderRevalidationsJobPayload =
  | {
      by: "id";
      data: {
        id: string;
        status: "active" | "inactive";
      };
    }
  | {
      by: "operator-or-zone";
      data: {
        origin: string;
        contract: string;
        blacklistedOperators?: string[];
        whitelistedOperators?: string[];
        // Relevant for invalidating orders with stale zones (the only use-case for this
        // at the moment is collections that switched to using the OS royalty-enforcing,
        // this will result in previous orders using no zone being unfillable)
        whitelistedZones?: string[];
        createdAtContinutation?: string;
        status: "inactive";
      };
    };

export default class OrderRevalidationsJob extends AbstractRabbitMqJobHandler {
  queueName = "order-revalidations";
  maxRetries = 10;
  concurrency = 20;
  backoff = {
    type: "exponential",
    delay: 10000,
  } as BackoffStrategy;

  public async process(payload: OrderRevalidationsJobPayload) {
    const { by, data } = payload;

    try {
      switch (by) {
        case "id": {
          const { id, status } = data;

          await idb.none(
            `
              UPDATE orders SET
                fillability_status = '${status === "active" ? "fillable" : "cancelled"}',
                approval_status = '${status === "active" ? "approved" : "disabled"}',
                updated_at = now()
              WHERE orders.id = $/id/
            `,
            { id }
          );

          // Recheck the order
          await orderUpdatesByIdJob.addToQueue([
            {
              context: `revalidation-${Date.now()}-${id}`,
              id,
              trigger: {
                kind: "revalidation",
              },
            } as OrderUpdatesByIdJobPayload,
          ]);

          break;
        }

        case "operator-or-zone": {
          const {
            contract,
            blacklistedOperators,
            whitelistedOperators,
            whitelistedZones,
            createdAtContinutation,
          } = data;

          if (!blacklistedOperators && !whitelistedOperators && !whitelistedZones) {
            return;
          }

          let done = true;

          const limit = 1000;
          for (const side of ["sell", "buy"]) {
            const results = await idb.manyOrNone(
              `
                WITH
                  x AS (
                    SELECT
                      orders.id,
                      orders.created_at
                    FROM orders
                    WHERE orders.contract = $/contract/
                      AND orders.side = $/side/
                      AND orders.fillability_status = 'fillable'
                      AND orders.approval_status = 'approved'
                      ${createdAtContinutation ? "AND orders.created_at < $/createdAt/" : ""}
                      ORDER BY orders.created_at DESC
                    LIMIT $/limit/
                  ),
                  y AS (
                    SELECT
                      x.created_at
                    FROM x
                    ORDER BY x.created_at DESC
                    LIMIT 1
                  )
                UPDATE orders SET
                  fillability_status = 'cancelled',
                  approval_status = 'disabled',
                  updated_at = now()
                FROM x
                WHERE orders.id = x.id
                  ${
                    blacklistedOperators
                      ? "AND orders.conduit = ANY(ARRAY[$/blacklistedOperators:list/]::BYTEA[])"
                      : ""
                  }
                  ${
                    whitelistedOperators
                      ? "AND orders.conduit <> ALL(ARRAY[$/whitelistedOperators:list/]::BYTEA[])"
                      : ""
                  }
                  ${
                    whitelistedZones
                      ? `
                        AND orders.raw_data->>'zone' IS NOT NULL
                        AND orders.raw_data->>'zone'::TEXT <> ALL(ARRAY[$/whitelistedZones:list/]::TEXT[])
                      `
                      : ""
                  }
                RETURNING
                  x.id,
                  (SELECT y.created_at FROM y) AS created_at
              `,
              {
                contract: toBuffer(contract),
                side,
                limit,
                blacklistedOperators: blacklistedOperators?.map((o) => toBuffer(o)),
                whitelistedOperators: whitelistedOperators?.map((o) => toBuffer(o)),
                whitelistedZones,
                createdAt: createdAtContinutation,
              }
            );

            logger.debug(this.queueName, JSON.stringify({ results, data }));

            // Recheck the orders
            await orderUpdatesByIdJob.addToQueue(
              results.map(
                (r) =>
                  ({
                    context: `revalidation-${Date.now()}-${r.id}`,
                    id: r.id,
                    trigger: {
                      kind: "revalidation",
                    },
                  } as OrderUpdatesByIdJobPayload)
              )
            );

            if (results.length >= 1) {
              done = false;
              payload.data.createdAtContinutation = results[0].created_at;
            }
          }

          if (!done) {
            await this.addToQueue([payload]);
          }

          break;
        }
      }
    } catch (error) {
      logger.error(
        this.queueName,
        `Failed to handle order revalidation info ${JSON.stringify(payload)}: ${error}`
      );
      throw error;
    }
  }

  public async addToQueue(orderRevalidationInfos: OrderRevalidationsJobPayload[]) {
    await this.sendBatch(orderRevalidationInfos.map((info) => ({ payload: info })));
  }
}

export const orderRevalidationsJob = new OrderRevalidationsJob();
