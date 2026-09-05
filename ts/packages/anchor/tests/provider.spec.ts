import { Keypair } from "@solana/web3.js";
import {
  addSignersToTransactionMessage,
  Blockhash,
  Nonce,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  SolanaError,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  TransactionPartialSigner,
  TransactionSigner,
} from "@solana/kit";
import { AnchorProvider, ProviderError } from "../src/provider";
import { ProgramError, translateError } from "../src/error";
import { createWallet } from "../src/wallet";
import {
  BLOCKHASH,
  confirmingResponders,
  decodeWireTransaction,
  expectFullySigned,
  latestBlockhashResponse,
  mockProvider,
  preflightFailureResponse,
  randomAddress,
  randomSigner,
  signatureBase58,
  simulationResponse,
  SYSTEM_PROGRAM,
  transferMessage,
} from "./helpers/mock-provider";

describe("AnchorProvider", () => {
  describe("construction", () => {
    it("exposes the wallet address as a legacy public key", () => {
      const { provider, wallet } = mockProvider({});
      expect(provider.publicKey.toBase58()).toBe(wallet.address);
    });

    it("does not expose the legacy connection when built from a Kit client", () => {
      const { provider } = mockProvider({});
      expect(() => provider.connection).toThrow(
        "constructed from cluster endpoints"
      );
    });

    it("exposes the legacy connection when built from endpoints", () => {
      const wallet = Keypair.generate();
      const provider = new AnchorProvider(
        "http://127.0.0.1:8899",
        createWallet(wallet.secretKey)
      );
      expect(provider.connection.rpcEndpoint).toBe("http://127.0.0.1:8899");
      expect(provider.rpc).toBeDefined();
      expect(provider.rpcSubscriptions).toBeDefined();
    });
  });

  describe("simulate", () => {
    it("compiles messages with the wallet as fee payer and a fresh blockhash", async () => {
      const { provider, wallet, requests } = mockProvider({
        getLatestBlockhash: latestBlockhashResponse,
        simulateTransaction: simulationResponse,
      });

      const response = await provider.simulate(transferMessage(wallet.address));

      expect(response.logs).toHaveLength(1);
      expect(response.unitsConsumed).toBe(150n);

      const request = requests.find((r) => r.method === "simulateTransaction")!;
      const { message } = decodeWireTransaction(request);
      expect(message.lifetimeToken).toBe(BLOCKHASH);
      expect(message.staticAccounts[0]).toBe(wallet.address);
      expect(message.staticAccounts).toContain(SYSTEM_PROGRAM);
      expect((request.params[1] as any).sigVerify).toBeUndefined();
    });

    it("keeps an explicit fee payer and signs for it", async () => {
      const { provider, wallet, requests } = mockProvider({
        getLatestBlockhash: latestBlockhashResponse,
        simulateTransaction: simulationResponse,
      });

      // Gas-sponsor pattern: the sponsor pays fees but is not referenced by
      // any instruction; it must still end up signing.
      const sponsor = randomSigner();
      const message = setTransactionMessageFeePayer(
        sponsor.address,
        transferMessage(wallet.address)
      );
      await provider.simulate(message, [sponsor.signer]);

      const request = requests.find((r) => r.method === "simulateTransaction")!;
      const { transaction, message: compiled } = decodeWireTransaction(request);
      expect(compiled.staticAccounts[0]).toBe(sponsor.address);
      expectFullySigned(transaction, 2);
    });

    it("signs and verifies signatures when signers are provided", async () => {
      const { provider, requests } = mockProvider({
        getLatestBlockhash: latestBlockhashResponse,
        simulateTransaction: simulationResponse,
      });

      const sender = randomSigner();
      await provider.simulate(transferMessage(sender.address), [sender.signer]);

      const request = requests.find((r) => r.method === "simulateTransaction")!;
      expect((request.params[1] as any).sigVerify).toBe(true);
      // Both the wallet and the extra signer signed for real: the decoder
      // maps zeroed (missing) signatures to null.
      expectFullySigned(decodeWireTransaction(request).transaction, 2);
    });

    it("keeps a lifetime already set on the message", async () => {
      const { provider, wallet, requests } = mockProvider({
        simulateTransaction: simulationResponse,
      });

      const ownBlockhash =
        "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi" as Blockhash;
      const message = setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: ownBlockhash, lastValidBlockHeight: 50n },
        transferMessage(wallet.address)
      );
      await provider.simulate(message);

      expect(requests.map((r) => r.method)).toEqual(["simulateTransaction"]);
      const { message: compiled } = decodeWireTransaction(requests[0]);
      expect(compiled.lifetimeToken).toBe(ownBlockhash);
    });

    it("requests post-simulation accounts when includeAccounts is set", async () => {
      const { provider, wallet, requests } = mockProvider({
        getLatestBlockhash: latestBlockhashResponse,
        simulateTransaction: (request) =>
          simulationResponse({
            accounts: (request.params[1] as any).accounts.addresses.map(
              () => null
            ),
          }),
      });

      await provider.simulate(
        transferMessage(wallet.address),
        undefined,
        undefined,
        true
      );

      const request = requests.find((r) => r.method === "simulateTransaction")!;
      const accountsConfig = (request.params[1] as any).accounts;
      // Every non-program account: the wallet (fee payer and sender) and
      // the recipient of the transfer.
      expect(accountsConfig.addresses).toHaveLength(2);
      expect(accountsConfig.addresses).toContain(wallet.address);
      expect(accountsConfig.addresses).not.toContain(SYSTEM_PROGRAM);
    });

    it("throws a SimulateError carrying logs when simulation fails", async () => {
      const { provider, wallet } = mockProvider({
        getLatestBlockhash: latestBlockhashResponse,
        simulateTransaction: () =>
          simulationResponse({
            err: { InstructionError: [0, { Custom: 6000 }] },
            logs: ["Program log: Error: Custom(6000)"],
          }),
      });

      const promise = provider.simulate(transferMessage(wallet.address));
      await expect(promise).rejects.toThrow('"Custom":6000');
      await expect(promise).rejects.toMatchObject({
        logs: ["Program log: Error: Custom(6000)"],
      });
    });
  });

  describe("sendAndConfirm", () => {
    it("sends a fully signed transaction and returns its signature", async () => {
      const { provider, wallet, requests } = mockProvider(
        confirmingResponders()
      );

      const signature = await provider.sendAndConfirm(
        transferMessage(wallet.address)
      );

      const request = requests.find((r) => r.method === "sendTransaction")!;
      const { transaction } = decodeWireTransaction(request);
      expectFullySigned(transaction, 1);
      expect(signature).toBe(signatureBase58(transaction));
    });

    it("uses the signers attached to the message", async () => {
      const { provider, requests } = mockProvider(confirmingResponders());

      const sender = randomSigner();
      const message = addSignersToTransactionMessage(
        [sender.signer],
        transferMessage(sender.address)
      );
      await provider.sendAndConfirm(message);

      const request = requests.find((r) => r.method === "sendTransaction")!;
      expectFullySigned(decodeWireTransaction(request).transaction, 2);
    });

    it("skips signers the transaction does not require", async () => {
      const { provider, wallet, requests } = mockProvider(
        confirmingResponders()
      );

      // Kit key pair signers refuse to sign transactions they are not part
      // of, so the provider must not hand them such transactions.
      const bystander = randomSigner();
      await provider.sendAndConfirm(transferMessage(wallet.address), [
        bystander.signer,
      ]);

      const request = requests.find((r) => r.method === "sendTransaction")!;
      expectFullySigned(decodeWireTransaction(request).transaction, 1);
    });

    it("rejects required signers that can only sign and send", async () => {
      const { provider } = mockProvider(confirmingResponders());

      const sendingOnly: TransactionSigner = {
        address: randomAddress(),
        signAndSendTransactions: async () => [],
      };
      const promise = provider.sendAndConfirm(
        transferMessage(sendingOnly.address),
        [sendingOnly]
      );
      await expect(promise).rejects.toThrow("can only sign and send");
    });

    it("does not refresh the blockhash of a message carrying its own", async () => {
      const { provider, wallet, requests } = mockProvider(
        confirmingResponders()
      );

      const message = setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 50n },
        transferMessage(wallet.address)
      );
      await provider.sendAndConfirm(message);

      expect(requests.map((r) => r.method)).not.toContain("getLatestBlockhash");
    });

    it("rejects durable nonce messages explicitly", async () => {
      const { provider, wallet } = mockProvider({});

      const message = setTransactionMessageLifetimeUsingDurableNonce(
        {
          nonce: BLOCKHASH as string as Nonce,
          nonceAccountAddress: randomAddress(),
          nonceAuthorityAddress: wallet.address,
        },
        transferMessage(wallet.address)
      );

      await expect(provider.sendAndConfirm(message)).rejects.toThrow(
        "Durable nonce transactions are not supported"
      );
    });

    it("throws a ProviderError carrying logs on preflight failure", async () => {
      const { provider, wallet, requests } = mockProvider({
        getLatestBlockhash: latestBlockhashResponse,
        sendTransaction: (request) =>
          preflightFailureResponse(request, {
            InstructionError: [0, { Custom: 6000 }],
          }),
      });

      const promise = provider.sendAndConfirm(transferMessage(wallet.address));
      await expect(promise).rejects.toThrow(ProviderError);
      await expect(promise).rejects.toThrow("Custom program error: #6000");
      await expect(promise).rejects.toMatchObject({
        logs: ["Program log: AnchorError thrown in programs/test/src/lib.rs"],
      });

      // No retry for non-"already processed" failures.
      expect(
        requests.filter((r) => r.method === "sendTransaction")
      ).toHaveLength(1);
    });

    it("refreshes the blockhash and retries when already processed", async () => {
      let sends = 0;
      const { provider, wallet, requests } = mockProvider({
        getLatestBlockhash: latestBlockhashResponse,
        getTransaction: () => null,
        sendTransaction: (request) => {
          sends += 1;
          return preflightFailureResponse(
            request,
            sends < 3
              ? "AlreadyProcessed"
              : { InstructionError: [0, { Custom: 6000 }] }
          );
        },
      });

      const promise = provider.sendAndConfirm(transferMessage(wallet.address));
      await expect(promise).rejects.toThrow("Custom program error: #6000");

      expect(
        requests.filter((r) => r.method === "sendTransaction")
      ).toHaveLength(3);
      // One blockhash fetch per attempt.
      expect(
        requests.filter((r) => r.method === "getLatestBlockhash")
      ).toHaveLength(3);
    });

    it("does not retry when the message carries its own blockhash", async () => {
      const { provider, wallet, requests } = mockProvider({
        getTransaction: () => null,
        sendTransaction: (request) =>
          preflightFailureResponse(request, "AlreadyProcessed"),
      });

      const message = setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 50n },
        transferMessage(wallet.address)
      );
      await expect(provider.sendAndConfirm(message)).rejects.toThrow(
        ProviderError
      );
      expect(
        requests.filter((r) => r.method === "sendTransaction")
      ).toHaveLength(1);
    });

    it("recovers logs and translates errors of failed sends", async () => {
      const logs = ["Program log: Custom error"];
      const failure = new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, {
        code: 6000,
        index: 0,
      });
      const { provider, wallet } = mockProvider({
        getLatestBlockhash: latestBlockhashResponse,
        sendTransaction: () => {
          throw failure;
        },
        getTransaction: () => ({
          slot: 2,
          meta: { logMessages: logs, err: { InstructionError: [0, {}] } },
          transaction: ["", "base64"],
        }),
      });

      const promise = provider.sendAndConfirm(transferMessage(wallet.address));
      await expect(promise).rejects.toThrow(ProviderError);
      await expect(promise).rejects.toMatchObject({ logs });

      // The Kit error survives in the cause chain, so translateError can
      // resolve the custom error code without message scraping.
      const err = await promise.catch((e) => e);
      const translated = translateError(err, new Map([[6000, "Custom error"]]));
      expect(translated).toBeInstanceOf(ProgramError);
      expect(translated.code).toBe(6000);
      expect(translated.msg).toBe("Custom error");
    });
  });

  describe("sendAll", () => {
    it("signs the whole batch with the wallet in a single request", async () => {
      const keypair = Keypair.generate();
      const inner = createWallet(keypair.secretKey);
      const signTransactions = jest.fn(inner.signTransactions);
      const wallet: TransactionPartialSigner = {
        address: inner.address,
        signTransactions,
      };
      const { provider, requests } = mockProvider(confirmingResponders(), {
        wallet,
      });

      const sender = randomSigner();
      const signatures = await provider.sendAll([
        { message: transferMessage(wallet.address) },
        { message: transferMessage(sender.address), signers: [sender.signer] },
      ]);

      expect(signatures).toHaveLength(2);
      expect(signTransactions).toHaveBeenCalledTimes(1);
      expect(signTransactions.mock.calls[0][0]).toHaveLength(2);

      const sent = requests.filter((r) => r.method === "sendTransaction");
      expect(sent).toHaveLength(2);
      expectFullySigned(decodeWireTransaction(sent[0]).transaction, 1);
      expectFullySigned(decodeWireTransaction(sent[1]).transaction, 2);
      // A single blockhash fetch is shared across the batch.
      expect(
        requests.filter((r) => r.method === "getLatestBlockhash")
      ).toHaveLength(1);
    });

    it("skips the wallet for transactions it does not sign", async () => {
      const keypair = Keypair.generate();
      const inner = createWallet(keypair.secretKey);
      const signTransactions = jest.fn(inner.signTransactions);
      const wallet: TransactionPartialSigner = {
        address: inner.address,
        signTransactions,
      };
      const { provider, requests } = mockProvider(confirmingResponders(), {
        wallet,
      });

      // Paid for and signed by the sponsor alone: the wallet has nothing to
      // sign and must not be asked to.
      const sponsor = randomSigner();
      const message = setTransactionMessageFeePayer(
        sponsor.address,
        transferMessage(sponsor.address)
      );
      await provider.sendAll([{ message, signers: [sponsor.signer] }]);

      expect(signTransactions).not.toHaveBeenCalled();
      const sent = requests.find((r) => r.method === "sendTransaction")!;
      expectFullySigned(decodeWireTransaction(sent).transaction, 1);
    });
  });
});
