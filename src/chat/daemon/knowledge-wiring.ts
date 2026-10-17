import { backfillSummaries } from "../../knowledge/backfill.js";
import { repairKnowledgeRefs } from "../../knowledge/repair-refs.js";
import { scanProjects } from "../../knowledge/scanner.js";
import type { ChatDaemon } from "../daemon.js";

export function startKnowledge(daemon: ChatDaemon): void {
  if (daemon.environment.MEGABRAIN_KNOWLEDGE_SCANNER === "off") return;
  const pass = async (backfill: boolean): Promise<void> => {
    if (daemon.scanning || daemon.draining || daemon.closed) return;
    daemon.scanning = true;
    try {
      if (backfill) {
        await repairKnowledgeRefs({ stateDir: daemon.stateDir, once: true });
        await backfillSummaries({ stateDir: daemon.stateDir, pipeline: daemon.knowledge });
      }
      await scanProjects({ stateDir: daemon.stateDir, home: daemon.environment.HOME ?? process.env.HOME ?? "", environment: daemon.environment, pipeline: daemon.knowledge });
    } catch (error) { process.stderr.write(`knowledge scan failed: ${error instanceof Error ? error.message : String(error)}\n`); }
    finally { daemon.scanning = false; }
  };
  const schedule = (backfill: boolean, delay: number, repeat = false) => {
    const run = () => {
      if (daemon.scanning || daemon.draining || daemon.closed) return;
      const task = pass(backfill);
      daemon.knowledgeTasks.add(task);
      void task.then(() => daemon.knowledgeTasks.delete(task));
    };
    const timer = repeat ? setInterval(run, delay) : setTimeout(run, delay);
    timer.unref();
    daemon.knowledgeTimers.push(timer);
  };
  schedule(true, 60_000);
  schedule(false, 10 * 60_000, true);
}
