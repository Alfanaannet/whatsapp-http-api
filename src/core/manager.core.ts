import {
  ConsoleLogger,
  Injectable,
  LogLevel,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { WhatsappConfigService } from '../config.service';
import { getLogLevels } from '../helpers';
import { WAHAEngine, WAHASessionStatus } from '../structures/enums.dto';
import {
  ProxyConfig,
  SessionDTO,
  SessionInfo,
  SessionLogoutRequest,
  SessionStartRequest,
  SessionStopRequest,
} from '../structures/sessions.dto';
import { WebhookConfig } from '../structures/webhooks.config.dto';
import { SessionManager } from './abc/manager.abc';
import { SessionParams, WhatsappSession } from './abc/session.abc';
import { WhatsappSessionNoWebCore } from './engines/noweb/session.noweb.core';
import { WhatsappSessionVenomCore } from './engines/venom/session.venom.core';
import { WhatsappSessionWebJSCore } from './engines/webjs/session.webjs.core';
import { DOCS_URL } from './exceptions';
import { getProxyConfig } from './helpers.proxy';
import { CoreMediaManager, MediaStorageCore } from './media.core';
import { LocalSessionAuthRepository } from './storage/LocalSessionAuthRepository';
import { LocalSessionConfigRepository } from './storage/LocalSessionConfigRepository';
import { LocalStoreCore } from './storage/LocalStoreCore';
import { WebhookConductorCore } from './webhooks.core';

export class OnlyDefaultSessionIsAllowed extends UnprocessableEntityException {
  constructor() {
    super(
      `WAHA Core support only 'default' session. If you want to run more then one WhatsApp account - please get WAHA PLUS version. Check this out: ${DOCS_URL}`,
    );
  }
}

export function buildLogger(name: string, levels: LogLevel[]) {
  return new ConsoleLogger(name, { logLevels: levels });
}

@Injectable()
export class SessionManagerCore extends SessionManager {
  private session?: WhatsappSession;
  DEFAULT = 'default';

  // @ts-ignore
  protected WebhookConductorClass = WebhookConductorCore;
  protected readonly EngineClass: typeof WhatsappSession;

  constructor(
    private config: WhatsappConfigService,
    private log: ConsoleLogger,
  ) {
    super();

    this.log.setContext('SessionManager');
    this.session = undefined;
    const engineName = this.config.getDefaultEngineName();
    this.EngineClass = this.getEngine(engineName);
    this.store = new LocalStoreCore(engineName.toLowerCase());
    this.sessionAuthRepository = new LocalSessionAuthRepository(this.store);
    this.sessionConfigRepository = new LocalSessionConfigRepository(this.store);
    this.startPredefinedSessions();
  }

  protected startPredefinedSessions() {
    const startSessions = this.config.startSessions;
    startSessions.forEach((sessionName) => {
      this.start({ name: sessionName });
    });
  }

  protected getEngine(engine: WAHAEngine): typeof WhatsappSession {
    if (engine === WAHAEngine.WEBJS) {
      return WhatsappSessionWebJSCore;
    } else if (engine === WAHAEngine.VENOM) {
      return WhatsappSessionVenomCore;
    } else if (engine === WAHAEngine.NOWEB) {
      return WhatsappSessionNoWebCore;
    } else {
      throw new NotFoundException(`Unknown whatsapp engine '${engine}'.`);
    }
  }

  private onlyDefault(name: string) {
    if (name !== this.DEFAULT) {
      throw new OnlyDefaultSessionIsAllowed();
    }
  }

  async onApplicationShutdown(signal?: string) {
    if (!this.session) {
      return;
    }
    await this.stop({ name: this.DEFAULT, logout: false });
  }

  //
  // API Methods
  //
  async start(request: SessionStartRequest): Promise<SessionDTO> {
    this.onlyDefault(request.name);

    const name = request.name;
    this.log.log(`'${name}' - starting session...`);
    const levels = getLogLevels(request.config?.debug);
    const log = buildLogger(`WhatsappSession - ${name}`, levels);
    const mediaManager = new CoreMediaManager(
      new MediaStorageCore(),
      this.config.mimetypes,
    );
    const webhookLog = buildLogger(`Webhook - ${name}`, levels);
    const webhook = new this.WebhookConductorClass(webhookLog);
    const proxyConfig = this.getProxyConfig(request);
    const sessionConfig: SessionParams = {
      name,
      mediaManager,
      log,
      sessionStore: this.store,
      proxyConfig: proxyConfig,
      sessionConfig: request.config,
    };
    await this.sessionAuthRepository.init(name);
    // @ts-ignore
    const session = new this.EngineClass(sessionConfig);
    this.session = session;

    // configure webhooks
    const webhooks = this.getWebhooks(request);
    webhook.configure(session, webhooks);

    // start session
    await session.start();
    return {
      name: session.name,
      status: session.status,
      config: session.sessionConfig,
    };
  }

  /**
   * Combine per session and global webhooks
   */
  private getWebhooks(request: SessionStartRequest) {
    let webhooks: WebhookConfig[] = [];
    if (request.config?.webhooks) {
      webhooks = webhooks.concat(request.config.webhooks);
    }
    const globalWebhookConfig = this.config.getWebhookConfig();
    if (globalWebhookConfig) {
      webhooks.push(globalWebhookConfig);
    }
    return webhooks;
  }

  /**
   * Get either session's or global proxy if defined
   */
  protected getProxyConfig(
    request: SessionStartRequest,
  ): ProxyConfig | undefined {
    if (request.config?.proxy) {
      return request.config.proxy;
    }
    if (!this.session) {
      return undefined;
    }
    const sessions = { [request.name]: this.session };
    return getProxyConfig(this.config, sessions, request.name);
  }

  async stop(request: SessionStopRequest): Promise<void> {
    this.onlyDefault(request.name);

    const name = request.name;
    this.log.log(`Stopping ${name} session...`);
    const session = this.getSession(name);
    await session.stop();
    this.log.log(`"${name}" has been stopped.`);
    this.session = undefined;
  }

  async logout(request: SessionLogoutRequest) {
    const name = request.name;
    this.onlyDefault(request.name);
    this.stop({ name: name, logout: false })
      .then(() => {
        this.log.log(`Session '${name}' has been stopped.`);
      })
      .catch((err) => {
        this.log.error(
          `Error while stopping session '${name}' while logging out`,
          err,
        );
      });
    await this.sessionAuthRepository.clean(request.name);
  }

  getSession(name: string): WhatsappSession {
    this.onlyDefault(name);
    const session = this.session;
    if (!session) {
      throw new NotFoundException(
        `We didn't find a session with name '${name}'. Please start it first by using POST /sessions/start request`,
      );
    }
    return session;
  }

  async getSessions(all: boolean): Promise<SessionInfo[]> {
    if (!this.session) {
      if (!all) {
        return [];
      }
      return [
        {
          name: this.DEFAULT,
          status: WAHASessionStatus.STOPPED,
          config: undefined,
          me: null,
        },
      ];
    }
    const me = await this.session.getSessionMeInfo().catch((err) => null);
    const engine = {
      engine: this.session?.engine,
      ...(await this.session?.getEngineInfo().catch((err) => ({}))),
    };
    return [
      {
        name: this.session.name,
        status: this.session.status,
        config: this.session.sessionConfig,
        me: me,
        engine: engine,
      },
    ];
  }

  async getSessionInfo(name: string): Promise<SessionInfo | null> {
    if (name !== this.DEFAULT) {
      return null;
    }
    return this.getSessions(true).then((sessions) => sessions[0]);
  }
}
