import { ApiProvider, BalanceData, Bridge, chains, FN, ChainName } from "@polkawallet/bridge";
import { KusamaAdapter, PolkadotAdapter } from "@polkawallet/bridge/build/adapters/polkadot";
import { AcalaAdapter, KaruraAdapter } from "@polkawallet/bridge/build/adapters/acala";
import { StatemineAdapter } from "@polkawallet/bridge/build/adapters/statemint";
import { AltairAdapter } from "@polkawallet/bridge/build/adapters/centrifuge";
import { ShidenAdapter } from "@polkawallet/bridge/build/adapters/astar";
import { BifrostAdapter } from "@polkawallet/bridge/build/adapters/bifrost";
import { CalamariAdapter } from "@polkawallet/bridge/build/adapters/manta";
import { ShadowAdapter } from "@polkawallet/bridge/build/adapters/crust";
import { CrabAdapter } from "@polkawallet/bridge/build/adapters/darwinia";
import { IntegriteeAdapter } from "@polkawallet/bridge/build/adapters/integritee";
import { QuartzAdapter } from "@polkawallet/bridge/build/adapters/unique";
import { Observable, firstValueFrom, combineLatest } from "rxjs";
import { BaseCrossChainAdapter } from "@polkawallet/bridge/build/base-chain-adapter";
import { subscribeMessage } from "./setting";

import { Keyring } from "@polkadot/keyring";
import { KeyringPair$Json, } from "@polkadot/keyring/types";
import BN from "bn.js";
import { ITuple } from "@polkadot/types/types";
import { DispatchError } from "@polkadot/types/interfaces";
import { SubmittableResult } from "@polkadot/api/submittable";
let keyring = new Keyring({ ss58Format: 0, type: "sr25519" });

const provider = new ApiProvider();

const availableAdapters: Record<string, BaseCrossChainAdapter> = {
  acala: new AcalaAdapter(),
  karura: new KaruraAdapter(),
  polkadot: new PolkadotAdapter(),
  kusama: new KusamaAdapter(),
  statemine: new StatemineAdapter(),
  altair: new AltairAdapter(),
  shiden: new ShidenAdapter(),
  bifrost: new BifrostAdapter(),
  calamari: new CalamariAdapter(),
  shadow: new ShadowAdapter(),
  crab: new CrabAdapter(),
  integritee: new IntegriteeAdapter(),
  quartz: new QuartzAdapter(),
};
const bridge = new Bridge({
  adapters: Object.values(availableAdapters),
});

async function connectFromChains(chains: ChainName[], nodeList: Partial<Record<ChainName, string[]>> | undefined) {
  // connect all adapters
  const connected = await firstValueFrom(provider.connectFromChain(chains, nodeList));

  await Promise.all(chains.map((chain) => availableAdapters[chain].setApi(provider.getApi(chain))));
  return connected;
}

async function disconnectFromChains() {
  const fromChains = Object.keys(availableAdapters) as ChainName[];
  fromChains.forEach((e) => provider.disconnect(e));
}

async function getFromChainsAll() {
  return Object.keys(availableAdapters);
}

async function getRoutes() {
  await bridge.isReady;
  return bridge.router.getAvailableRouters().map((e) => ({ from: e.from.id, to: e.to.id, token: e.token }));
}

async function getChainsInfo() {
  return chains;
}

async function getNetworkProperties(chain: ChainName) {
  const props = await provider.getApiPromise(chain).rpc.system.properties();
  return {
      ss58Format: parseInt(props.ss58Format.toString()),
      tokenDecimals: props.tokenDecimals.toJSON(),
      tokenSymbol: props.tokenSymbol.toJSON(),
  };
}

async function subscribeBalancesInner(chain: ChainName, address: string, callback: Function) {
  const adapter = bridge.findAdapter(chain);
  const tokens = {};
  adapter.getRouters().forEach((e) => {
    tokens[e.token] = true;
  });
  const sub = combineLatest(
    Object.keys(tokens).reduce((res, token) => {
      return { ...res, [token]: adapter.subscribeTokenBalance(token, address) };
    }, {}) as Record<string, Observable<BalanceData>>
  ).subscribe((all) => {
    callback(
      Object.keys(all).reduce(
        (res, token) => ({
          ...res,
          [token]: {
            token,
            decimals: all[token].free.getPrecision(),
            free: all[token].free.toChainData().toString(),
            locked: all[token].locked.toChainData().toString(),
            reserved: all[token].reserved.toChainData().toString(),
            available: all[token].available.toChainData().toString(),
          },
        }),
        {}
      )
    );
  });
  return () => sub.unsubscribe();
}

async function subscribeBalances(chain: ChainName, address: string, msgChannel: string) {
  subscribeMessage((<any>window).bridge.subscribeBalancesInner, [chain, address], msgChannel, undefined);
  return;
}

async function getInputConfig(from: ChainName, to: ChainName, token: string, address: string, signer: string) {
  const adapter = bridge.findAdapter(from);

  const res = await firstValueFrom(adapter.subscribeInputConfigs({ to, token, address, signer }));
  return {
    from,
    to,
    token,
    address,
    decimals: res.minInput.getPrecision(),
    minInput: res.minInput.toChainData().toString(),
    maxInput: res.maxInput.toChainData().toString(),
    destFee: {
      token: res.destFee.token,
      amount: res.destFee.balance.toChainData().toString(),
      decimals: res.destFee.balance.getPrecision()
    },
    estimateFee: res.estimateFee
  };
}

async function getTxParams(
  chainFrom: ChainName,
  chainTo: ChainName,
  token: string,
  address: string,
  amount: string,
  decimals: number,
  signer: string,
) {
  const adapter = bridge.findAdapter(chainFrom);
  const tx = adapter.createTx({ to: chainTo, token, address, amount: FN.fromInner(amount, decimals), signer });
  return {
    module: tx.method.section,
    call: tx.method.method,
    params: tx.args,
  }
}

async function sendTx(
  chainFrom: RegisteredChainName,
  chainTo: RegisteredChainName,
  token: string,
  address: string,
  amount: string,
  decimals: number,
  txInfo: any,
  password: string,
  msgId: string,
  keyPairJson: KeyringPair$Json,) {

  const adapter = bridge.findAdapter(chainFrom);
  return new Promise(async (resolve) => {
    const api = getApi(chainFrom);
    const { module, call, params } = await getTxParams(chainFrom, chainTo, token, address, amount, decimals);
    const tx = api.tx[module][call](...params);

    const onStatusChange = (result: SubmittableResult) => {

      if (result.status.isInBlock || result.status.isFinalized) {
        const { success, error } = _extractEvents(result);
        if (success) {
          resolve({ hash: tx.hash.toString() });
        }
        if (error) {
          resolve({ error });
        }
      } else {
        (<any>window).send(msgId, result.status.type);
      }
    };

    let keyPair = keyring.addFromJson(keyPairJson);
    try {
      keyPair.decodePkcs8(password);
    } catch (err) {
      resolve({ error: "password check failed" });
    }
    tx.signAndSend(keyPair, { tip: new BN(txInfo.tip, 10) }, onStatusChange);
  });
}

function _extractEvents(result: SubmittableResult) {
  if (!result || !result.events) {
    return {};
  }

  let success = false;
  let error: string;
  result.events
    .filter((event) => !!event.event)
    .map(({ event: { data, method, section } }) => {
      if (section === "system" && method === "ExtrinsicFailed") {
        const [dispatchError] = (data as unknown) as ITuple<[DispatchError]>;
        error = _getDispatchError(dispatchError);

        (<any>window).send("txUpdateEvent", {
          title: `${section}.${method}`,
          message: error,
        });
      } else {
        (<any>window).send("txUpdateEvent", {
          title: `${section}.${method}`,
          message: "ok",
        });
        if (section == "system" && method == "ExtrinsicSuccess") {
          success = true;
        }
      }
    });
  return { success, error };
}


function _getDispatchError(dispatchError: DispatchError): string {
  let message: string = dispatchError.type;

  if (dispatchError.isModule) {
    try {
      const mod = dispatchError.asModule;
      const error = dispatchError.registry.findMetaError(mod);

      message = `${error.section}.${error.name}`;
    } catch (error) {
      // swallow
    }
  } else if (dispatchError.isToken) {
    message = `${dispatchError.type}.${dispatchError.asToken.type}`;
  }

  return message;
}

function checkPassword(keyPairJson: KeyringPair$Json, pubKey: string, pass: string) {
  return new Promise((resolve) => {
    const keyPair = keyring.addFromJson(keyPairJson);
    try {
      if (!keyPair.isLocked) {
        keyPair.lock();
      }
      keyPair.decodePkcs8(pass);
    } catch (err) {
      resolve(null);
    }
    resolve({ success: true });
  });
}

function getApi(chainName: ChainName) {
  return provider.getApiPromise(chainName);
}

export default {
  getFromChainsAll,
  getRoutes,
  getChainsInfo,
  connectFromChains,
  disconnectFromChains,
  getNetworkProperties,
  subscribeBalancesInner,
  subscribeBalances,
  getInputConfig,
  getTxParams,
  getApi,
  sendTx,
  checkPassword,
};
