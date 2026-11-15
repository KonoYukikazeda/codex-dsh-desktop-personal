import { createMcpHttpServer } from './lib/server.js';
import { createSessionManager } from './lib/sessions.js';
import { createTools } from './lib/tools.js';

export function apply(ctx, config = {}) {
  ctx.inject(['sessionController', 'sessions', 'agents', 'workspaceRegistry', 'profileContext'], (injected) => {
    const logger = injected.logger?.('codex-dsh-desktop') ?? console;
    const manager = createSessionManager({
      sessionController: injected.sessionController,
      sessions: injected.sessions,
      agents: injected.agents,
      workspaceRegistry: injected.workspaceRegistry,
      sessionQuery: injected.get?.('sessionQuery') ?? injected.sessionQuery,
      profileContext: injected.profileContext,
      config
    });
    const bridge = createMcpHttpServer({
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 59873,
      path: config.path ?? '/mcp',
      token: config.token,
      serverName: 'codex-dsh-desktop',
      version: '1.1.0',
      instructions: 'Codex 是规划者：负责拆分模块、关键决策、复核关键结果与复用证据并做业务裁决，只派发边界清晰的模块任务；DeepSeek 负责任务范围内完成和一次主验。worker 不继承你的对话，每次 task 都要写全目标、约束、必读文件和验收方式。后续返工复用同一 workerId/sessionId，除非职责或上下文确实独立，不要另建 worker。插件会按 DSH profile 自动保存并恢复 worker 与 session 绑定，DSH/插件重启后仍用原 sessionId；MCP 客户端只需连接本机端口，断开不会取消 worker。此前未保存的旧会话可用 dsh_bind_worker 一次性迁入。派发后用 dsh_wait_worker/dsh_get_progress 监督，用 nextSeq 分页。完成 handoff 的 awaitingReview 为 true；succeeded 只表示 DeepSeek 当前 turn 正常结束，不等于最终验收。若复核需要修改或追加，用同一 workerId 调用 dsh_assign_task。若会话已被真正删除，插件会明确报错，不会静默新建替代会话。',
      tools: createTools(manager),
      logger
    });

    injected.on('agent/error', manager.onAgentError);
    injected.on('agent/assistant-stream', manager.onAssistantStream);
    injected.effect(() => {
      let disposed = false;
      void manager.ready().then(() => {
        if (disposed) return undefined;
        return bridge.start().then((address) => {
          if (!disposed) logger.info?.(`MCP endpoint listening at http://${config.host ?? '127.0.0.1'}:${address.port}${config.path ?? '/mcp'}`);
        });
      }).catch((error) => logger.error?.(`Failed to start MCP endpoint: ${error.message}`));
      return async () => {
        disposed = true;
        await Promise.all([manager.dispose(), bridge.close()]);
      };
    }, 'codex-dsh-desktop:mcp-server');
  });
}

export default apply;
