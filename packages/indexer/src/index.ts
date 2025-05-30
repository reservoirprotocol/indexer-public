import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import * as Sdk from "@reservoir0x/sdk";

import "@/common/tracer";

import { RabbitMq } from "@/common/rabbit-mq";
import { acquireLock, redis, releaseLock } from "@/common/redis";
import { runDBMigration } from "@/common/db-migrate";
import { config } from "@/config/index";
import { logger } from "@/common/logger";
import _ from "lodash";

runDBMigration().then(() => {
  // Initialize the SDK - this step must be done before reaching any imports that reference the SDK
  Sdk.Global.Config.addresses = Sdk.Addresses;
  Sdk.Global.Config.aggregatorSource = "reservoir.tools";

  if (Number(process.env.LOCAL_TESTING)) {
    import("./setup");
  } else {
    RabbitMq.createVhost()
      .then(() => RabbitMq.connect())
      .then(async () => {
        // Sync the pods so rabbit queues assertion will run only once per deployment by a single pod
        if (await acquireLock(config.imageTag, 75)) {
          const hash = await RabbitMq.assertQueuesAndExchangesHash();
          logger.info("rabbit-timing", `rabbit assertion hash ${hash}`);
          if ((await redis.get(RabbitMq.hashKey)) !== hash) {
            const start = _.now();

            logger.info("rabbit-timing", `rabbit assertion starting in ${start}`);

            await RabbitMq.assertQueuesAndExchanges().catch(async (error) => {
              await releaseLock(config.imageTag);
              throw error;
            });

            if (config.rabbitHostnameBackfill) {
              await RabbitMq.assertQueuesAndExchanges("backfill");
            }

            logger.info("rabbit-timing", `rabbit assertion done in ${_.now() - start}ms`);

            // Clean any not in use queues
            try {
              await RabbitMq.deleteQueues(`${__dirname}/jobs`, true);
            } catch (error) {
              logger.error("rabbit-delete-queue", `Error deleting queue ${error}`);
            }

            await redis.set(RabbitMq.hashKey, hash);
          }

          await redis.set(config.imageTag, "DONE", "EX", 60 * 60 * 24); // Update the lock ttl
          import("./setup");
        } else {
          // Check every 1s if the rabbit queues assertion completed
          const intervalId = setInterval(async () => {
            if ((await redis.get(config.imageTag)) === "DONE") {
              clearInterval(intervalId);
              import("./setup");
            }
          }, 1000);
        }
      })
      .catch((error) => {
        logger.error(
          "rabbit-publisher-connect",
          `Error connecting to rabbit ${JSON.stringify(error)}`
        );

        throw error;
      });
  }
});
