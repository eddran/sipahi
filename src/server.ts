import * as pino from "pino";
import { ServiceError } from "./error";
import { Logger, LoggerOptions } from "pino";
import { ServerUnaryCall } from "@grpc/grpc-js/src/server-call";
import { Server, ServerCredentials, status, Metadata } from "@grpc/grpc-js";
import { getServiceNames, loadPackage, lookupPackage } from "./loader";

export { status };

export { ServiceError as SipahiError };

interface CustomLogger extends LoggerOptions {
  properties: { [key: string]: any };
}

interface IConstructor {
  logger: boolean | LoggerOptions | CustomLogger;
}

declare type UseHandler = (myArgument: { request: object; metadata: Metadata; logger: Logger }) => any;

declare type ReqHookHandler = (myArgument: { request: object; metadata: Metadata; logger: Logger }) => any;

declare type ResHookHandler = (myArgument: { request: object; response: object; metadata: Metadata; logger: Logger }) => any;

declare type ErrHookHandler = (myArgument: { method: string; error: Error; logger: Logger }) => any;

export class Sipahi {
  public server: Server;
  private logger: Logger;
  private readonly listObjs: { [key: string]: any };
  private readonly reqHooks: any[];
  private readonly resHooks: any[];
  private readonly errHooks: any[];

  private protoList: { path: string; name: string }[];

  constructor(params: IConstructor = { logger: {} }) {
    this.listObjs = {};
    this.reqHooks = [];
    this.resHooks = [];
    this.errHooks = [];
    this.protoList = [];
    this.initialize();
    this.initLogging(params.logger);
  }

  private initLogging(config: any) {
    if (config) {
      config = {
        ...config,
        ...{
          timestamp: false,
          messageKey: "message",
          base: null,
          formatters: {
            level(label) {
              return {
                level: label,
              };
            },
          },
        },
      };

      let baseLogger = pino(config);
      this.logger = baseLogger.child(config.properties ? config.properties : {});
    }
  }

  private initialize() {
    this.server = new Server({
      "grpc.max_receive_message_length": -1,
      "grpc.max_send_message_length": -1,
    });
  }

  addProto(protoPath: string, packageName: string) {
    this.protoList.push({ path: protoPath, name: packageName });
  }

  private async getBeforeHooks(params: any) {
    for (let reqHook of this.reqHooks) {
      await reqHook(params);
    }
  }

  private async getAfterHooks(params: any) {
    for (let resHook of this.resHooks) {
      await resHook(params);
    }
  }

  private async getErrorHooks(params: any) {
    for (let errHook of this.errHooks) {
      await errHook(params);
    }
  }

  use(method: string, prmFnc: UseHandler): void {
    let self = this;
    this.listObjs[method] = function (call: ServerUnaryCall<any, any>, callback) {
      self
        .getBeforeHooks({
          request: call.request,
          metadata: call.metadata,
          logger: self.logger,
        })
        .then(() => {
          return prmFnc({
            data: call.request,
            // @ts-ignore
            metadata: call.metadata,
            logger: self.logger,
          })
            .then((mainResp) => {
              self
                .getAfterHooks({
                  request: call.request,
                  response: mainResp,
                  metadata: call.metadata,
                  logger: self.logger,
                })
                .then(() => {
                  callback(null, mainResp);
                })
                .catch((resErr) => {
                  callback(resErr, null);
                });
            })
            .catch((error) => {
              //  self.emit("error", { method, error });
              self
                .getErrorHooks({ method, error, logger: self.logger })
                .then(callback(error, null))
                .catch((hookErr) => {
                  callback(error, hookErr);
                });
            });
        })
        .catch((reqErr) => {
          callback(reqErr, null);
        });
    };
  }

  addHook(name: "onRequest" | "onResponse" | "onError", fn: ReqHookHandler | ResHookHandler | ErrHookHandler): void {
    switch (name) {
      case "onRequest":
        this.reqHooks.push(fn);
        break;

      case "onResponse":
        this.resHooks.push(fn);
        break;

      case "onError":
        this.errHooks.push(fn);
        break;
    }
  }

  private syncMethods() {
    this.protoList.forEach((proto) => {
      const pkg = lookupPackage(loadPackage(proto.path), proto.name);
      for (const serviceName of getServiceNames(pkg)) {
        const serviceData = (pkg[serviceName] as any) as any;
        this.server.addService(serviceData.service, this.listObjs);
      }
    });
  }

  listen(args: { host?: string; port?: number } = {}): Promise<{ host: string; port: number }> {
    if (!args.host) {
      args.host = "0.0.0.0";
    }
    if (!args.port) {
      throw new Error("You need to define port argument!");
    }
    this.syncMethods();
    return new Promise((resolve, reject) => {
      this.server.bindAsync(args.host + ":" + args.port, ServerCredentials.createInsecure(), (err) => {
        if (err) {
          return reject(err);
        }
        this.server.start();
        resolve({ host: args.host, port: args.port });
      });
    });
  }

  close() {
    return this.server.forceShutdown();
  }
}