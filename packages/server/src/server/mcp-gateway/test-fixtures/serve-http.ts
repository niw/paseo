// Runs an HTTP gateway for one home, as `paseo mcp daemon run` does, for the instance tests.
import { mcpGatewayLogPath, resolveMcpGatewayConfigPath, startMcpGateway } from "../gateway.js";

const home = process.argv[2]!;
const gateway = await startMcpGateway({
  configPath: resolveMcpGatewayConfigPath(home),
  transport: "http",
  lockHome: home,
  logFile: mcpGatewayLogPath(home),
  identity: { clientId: "mcp-gateway-instance-test" },
});
process.once("SIGTERM", () => {
  void gateway.stop().then(() => process.exit(0));
});
