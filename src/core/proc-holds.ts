import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";
import { failed, ok, type Result } from "./result.js";
import { resolveStateDirectory } from "./state.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Hold = Readonly<{ id: string; pid: number; createdAt: string }>;

// A hold says "process <pid> is using <resource>". It lasts as long as that process lives, so a
// holder that dies without releasing never pins the resource.
const DEFAULT_DOCKER_IDLE_SECONDS = 120;

function procsDirectory(environment: Environment): string {
  return join(resolveStateDirectory(environment), "procs");
}

function holdsDirectory(environment: Environment, resource: string): string {
  return join(procsDirectory(environment), "holds", resource);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function writeHold(environment: Environment, resource: string, hold: Hold): Promise<void> {
  const directory = holdsDirectory(environment, resource);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${hold.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(hold)}\n`, { mode: 0o600 });
  await rename(temporary, join(directory, `${hold.id}.json`));
}

export async function acquireHold(environment: Environment, resource: string, pid: number): Promise<string> {
  const id = `hold-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await writeHold(environment, resource, { id, pid, createdAt: new Date().toISOString() });
  return id;
}

// A detached process is started by a short-lived command; the hold moves to the process itself.
export async function reassignHold(environment: Environment, resource: string, id: string, pid: number): Promise<void> {
  await writeHold(environment, resource, { id, pid, createdAt: new Date().toISOString() });
}

export async function releaseHold(environment: Environment, resource: string, id: string): Promise<void> {
  await rm(join(holdsDirectory(environment, resource), `${id}.json`), { force: true });
}

export async function liveHolds(environment: Environment, resource: string): Promise<number> {
  const directory = holdsDirectory(environment, resource);
  let count = 0;
  for (const file of (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json") && !name.startsWith("."))) {
    let hold: Hold | undefined;
    try { hold = JSON.parse(await readFile(join(directory, file), "utf8")) as Hold; } catch { continue; }
    if (alive(hold.pid)) count += 1;
    else await rm(join(directory, file), { force: true });
  }
  return count;
}

function which(environment: Environment, command: string): string | undefined {
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return undefined;
}

// Starting and stopping docker are serialised by one lock directory, shared with the reaper, so
// a stop can never land between a new holder's check and its use.
async function withDockerLock<T>(environment: Environment, body: () => Promise<T>): Promise<T> {
  const lock = join(procsDirectory(environment), "docker.lock");
  await mkdir(procsDirectory(environment), { recursive: true });
  const deadline = Date.now() + 180_000;
  for (;;) {
    try { await mkdir(lock); break; } catch {
      if (Date.now() > deadline) throw new Error("timed out waiting for the docker lock");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try { return await body(); } finally { await rm(lock, { recursive: true, force: true }); }
}

async function dockerUp(docker: string, processAdapter: ProcessAdapter): Promise<boolean> {
  return (await processAdapter.run(docker, ["info"], { timeoutMs: 10_000 })).kind === "ok";
}

// Takes a docker hold for <pid>. When docker is down and OrbStack is installed, starts it and
// marks it as megabrain's, so the reaper stops it once no holder is left for the idle period.
// Docker that was already running is never stopped.
export async function holdDocker(environment: Environment, processAdapter: ProcessAdapter, pid: number): Promise<Result<string>> {
  const id = await acquireHold(environment, "docker", pid);
  const docker = which(environment, "docker");
  if (docker === undefined) { await releaseHold(environment, "docker", id); return failed("docker is not installed"); }
  try {
    return await withDockerLock(environment, async () => {
      const marker = join(procsDirectory(environment), "docker-started-by-megabrain");
      if (!(await dockerUp(docker, processAdapter))) {
        const orb = which(environment, "orb");
        if (orb === undefined) { await releaseHold(environment, "docker", id); return failed("docker is not running, and only OrbStack can be started by megabrain"); }
        const started = await processAdapter.run(orb, ["start"], { timeoutMs: 120_000 });
        if (started.kind !== "ok") { await releaseHold(environment, "docker", id); return failed(`orb start failed: ${started.error}`); }
        const deadline = Date.now() + 60_000;
        while (!(await dockerUp(docker, processAdapter))) {
          if (Date.now() > deadline) { await releaseHold(environment, "docker", id); return failed("docker did not come up after orb start"); }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await writeFile(marker, `${new Date().toISOString()}\n`);
      }
      if (await readFile(marker, "utf8").then(() => true, () => false)) {
        const reaped = await ensureReaper(environment, processAdapter, which(environment, "orb"));
        if (reaped.kind !== "ok") return reaped;
      }
      return ok(id);
    });
  } catch (error) {
    await releaseHold(environment, "docker", id);
    return failed(error instanceof Error ? error.message : String(error));
  }
}

// One detached reaper per state directory while megabrain owns a running docker. It exits when
// it has stopped docker or when the ownership marker is gone.
async function ensureReaper(environment: Environment, processAdapter: ProcessAdapter, orb: string | undefined): Promise<Result<void>> {
  if (orb === undefined) return ok(undefined);
  const pidFile = join(procsDirectory(environment), "docker-reaper.pid");
  const existing = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
  if (Number.isInteger(existing) && existing > 1 && alive(existing)) return ok(undefined);
  const idleSeconds = Number(environment.MEGABRAIN_DOCKER_IDLE_SECONDS);
  const payload = {
    procs: procsDirectory(environment),
    holds: holdsDirectory(environment, "docker"),
    idleMs: (Number.isFinite(idleSeconds) && idleSeconds > 0 ? idleSeconds : DEFAULT_DOCKER_IDLE_SECONDS) * 1000,
    orb,
  };
  const script = `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const c=JSON.parse(Buffer.from(process.argv[1],'base64').toString());const marker=path.join(c.procs,'docker-started-by-megabrain'),pidFile=path.join(c.procs,'docker-reaper.pid'),lock=path.join(c.procs,'docker.lock');fs.writeFileSync(pidFile,String(process.pid));function alive(p){try{process.kill(p,0);return true}catch(e){return e.code==='EPERM'}}function holders(){let n=0;for(const f of (fs.existsSync(c.holds)?fs.readdirSync(c.holds):[])){if(!f.endsWith('.json')||f.startsWith('.'))continue;try{const h=JSON.parse(fs.readFileSync(path.join(c.holds,f),'utf8'));if(alive(h.pid))n++;else fs.rmSync(path.join(c.holds,f),{force:true})}catch{}}return n}function done(){try{if(fs.readFileSync(pidFile,'utf8').trim()===String(process.pid))fs.rmSync(pidFile,{force:true})}catch{}process.exit(0)}let idleSince;setInterval(()=>{if(!fs.existsSync(marker))done();if(holders()>0){idleSince=undefined;return}idleSince??=Date.now();if(Date.now()-idleSince<c.idleMs)return;try{fs.mkdirSync(lock)}catch{return}try{if(holders()===0){cp.spawnSync(c.orb,['stop'],{stdio:'ignore',timeout:120000});fs.rmSync(marker,{force:true})}}finally{fs.rmSync(lock,{recursive:true,force:true})}if(!fs.existsSync(marker))done()},Math.min(1000,c.idleMs));`;
  const started = await processAdapter.startDetached(process.execPath, ["-e", script, Buffer.from(JSON.stringify(payload)).toString("base64")]);
  if (started.kind !== "ok") return started;
  await writeFile(pidFile, String(started.value.pid));
  return ok(undefined);
}
