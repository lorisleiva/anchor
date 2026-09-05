import { address, getU64Codec } from "@solana/kit";
import { Idl, Program } from "../src";
import { mockProvider } from "./helpers/mock-provider";

const PROGRAM_ADDRESS = address("Test111111111111111111111111111111111111111");
const SIGNATURE =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

const idl = {
  address: PROGRAM_ADDRESS,
  metadata: { name: "counter", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  events: [
    { name: "incremented", discriminator: [1, 2, 3, 4, 5, 6, 7, 8] },
    { name: "reset", discriminator: [8, 7, 6, 5, 4, 3, 2, 1] },
  ],
  types: [
    {
      name: "incremented",
      type: { kind: "struct", fields: [{ name: "count", type: "u64" }] },
    },
    { name: "reset", type: { kind: "struct", fields: [] } },
  ],
} as const satisfies Idl;
type CounterIdl = typeof idl;

function eventLog(discriminator: readonly number[], count?: bigint) {
  const data = Buffer.concat([
    Buffer.from(discriminator),
    count === undefined
      ? Buffer.alloc(0)
      : Buffer.from(getU64Codec().encode(count)),
  ]);
  return `Program data: ${data.toString("base64")}`;
}

function logsNotification(
  logs: string[],
  options: { slot?: number; err?: unknown } = {}
) {
  return {
    context: { slot: BigInt(options.slot ?? 10) },
    value: {
      err: options.err ?? null,
      logs: [
        `Program ${PROGRAM_ADDRESS} invoke [1]`,
        ...logs,
        `Program ${PROGRAM_ADDRESS} success`,
      ],
      signature: SIGNATURE,
    },
  };
}

/**
 * A `logsNotifications` mock recording every call and yielding the given
 * notifications, then hanging until aborted (like a live subscription).
 */
function logsSubscriptions(
  notifications: ReturnType<typeof logsNotification>[],
  calls: unknown[][] = [],
  aborted: AbortSignal[] = []
) {
  return {
    logsNotifications: (...args: unknown[]) => {
      calls.push(args);
      return {
        subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
          aborted.push(abortSignal);
          return (async function* () {
            for (const notification of notifications) {
              if (abortSignal.aborted) return;
              yield notification;
            }
            await new Promise<void>((resolve) =>
              abortSignal.addEventListener("abort", () => resolve())
            );
          })();
        },
      };
    },
  };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Program.addEventListener", () => {
  it("invokes the callback for matching events with slot and signature", async () => {
    const calls: unknown[][] = [];
    const { provider } = mockProvider(
      {},
      {
        subscriptions: logsSubscriptions(
          [
            logsNotification([eventLog([1, 2, 3, 4, 5, 6, 7, 8], 5n)], {
              slot: 42,
            }),
            logsNotification([eventLog([8, 7, 6, 5, 4, 3, 2, 1])]),
            logsNotification([eventLog([1, 2, 3, 4, 5, 6, 7, 8], 6n)]),
          ],
          calls
        ),
      }
    );
    const program = new Program<CounterIdl>(idl, provider);

    const received: [bigint, bigint, string][] = [];
    const controller = new AbortController();
    program.addEventListener(
      "incremented",
      (event, slot, signature) => {
        received.push([event.count, slot, signature]);
      },
      { abortSignal: controller.signal }
    );
    await nextTick();
    controller.abort();

    expect(received).toEqual([
      [5n, 42n, SIGNATURE],
      [6n, 10n, SIGNATURE],
    ]);
    // Mentions this program, at the provider's default commitment.
    expect(calls).toEqual([
      [{ mentions: [PROGRAM_ADDRESS] }, { commitment: "confirmed" }],
    ]);
  });

  it("ignores logs of failed transactions", async () => {
    const { provider } = mockProvider(
      {},
      {
        subscriptions: logsSubscriptions([
          logsNotification([eventLog([1, 2, 3, 4, 5, 6, 7, 8], 1n)], {
            err: { InstructionError: [0, "Custom"] },
          }),
        ]),
      }
    );
    const program = new Program<CounterIdl>(idl, provider);

    const callback = jest.fn();
    const controller = new AbortController();
    program.addEventListener("incremented", callback, {
      abortSignal: controller.signal,
    });
    await nextTick();
    controller.abort();

    expect(callback).not.toHaveBeenCalled();
  });

  it("stops listening when the signal is aborted", async () => {
    const aborted: AbortSignal[] = [];
    const { provider } = mockProvider(
      {},
      { subscriptions: logsSubscriptions([], [], aborted) }
    );
    const program = new Program<CounterIdl>(idl, provider);

    const controller = new AbortController();
    program.addEventListener("reset", () => {}, {
      abortSignal: controller.signal,
    });
    await nextTick();
    // The caller's signal is handed straight to the Kit subscription.
    expect(aborted).toEqual([controller.signal]);
    expect(controller.signal.aborted).toBe(false);

    controller.abort();
    expect(aborted[0].aborted).toBe(true);
  });

  it("forwards the listener commitment and reports subscription failures", async () => {
    const calls: unknown[][] = [];
    const failure = new Error("websocket closed");
    const { provider } = mockProvider(
      {},
      {
        subscriptions: {
          logsNotifications: (...args: unknown[]) => {
            calls.push(args);
            return {
              subscribe: async () => {
                throw failure;
              },
            };
          },
        },
      }
    );
    const program = new Program<CounterIdl>(idl, provider);

    const error = await new Promise<unknown>((resolve) => {
      program.addEventListener("reset", () => {}, {
        abortSignal: new AbortController().signal,
        commitment: "processed",
        onError: resolve,
      });
    });

    expect(error).toBe(failure);
    expect(calls[0][1]).toEqual({ commitment: "processed" });
  });

  it("requires the provider to have subscriptions", () => {
    const { provider: inner } = mockProvider({});
    const program = new Program<CounterIdl>(idl, { rpc: inner.rpc });

    expect(() =>
      program.addEventListener("reset", () => {}, {
        abortSignal: new AbortController().signal,
      })
    ).toThrow("`rpcSubscriptions`");
  });
});
