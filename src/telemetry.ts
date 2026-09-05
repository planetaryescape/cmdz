import { Config, Effect, Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

export const telemetry = Layer.unwrap(Effect.gen(function* () {
  const enabled = yield* Config.boolean("CMDZ_TELEMETRY").pipe(Config.withDefault(true));
  if (!enabled) return Logger.layer([], { mergeWithExisting: false });

  const baseUrl = yield* Config.string("CMDZ_OTLP_URL").pipe(
    Config.withDefault("http://127.0.0.1:27686"),
  );
  const endpoint = baseUrl.replace(/\/+$/, "");
  const resource = { serviceName: "cmdz" };

  return Layer.merge(
    OtlpTracer.layer({
      url: `${endpoint}/v1/traces`,
      resource,
      exportInterval: "1 second",
      shutdownTimeout: "1 second",
    }),
    OtlpLogger.layer({
      url: `${endpoint}/v1/logs`,
      resource,
      exportInterval: "1 second",
      shutdownTimeout: "1 second",
      mergeWithExisting: false,
    }),
  ).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );
}));
