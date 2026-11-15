// Windows Job Objects for hosted sessions: one job per session, with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so closing
// the job ends the session's program and every child it started after the assign, detached ones too. No native
// dependency: one hidden `powershell.exe` child of main compiles a small C# class with `Add-Type` and holds the job
// handles. When that helper ends (its stdin closes, or it is killed), Windows closes its handles, so every job's
// processes end too. No `electron` import: the glue passes Node's `spawn`. The rules are in
// pod-docs/sprints/session-life.md (§7, J1).
//
// Lines, one request at a time, answered in order:
//   main → helper: `assign <id> <pid>`  `close <id>`
//   helper → main: `ok <id>`  `fail <id> <win32 error>`  `closed <id>`

export type JobControl = {
  /** Puts a running process in the session's job. False on any failure: the caller falls back to a tree kill. */
  assign(id: string, pid: number): Promise<boolean>
  /** Ends every process in the session's job and drops the job. Never rejects; waits at most CLOSE_MS. */
  close(id: string): Promise<void>
  /** Ends the helper's input, so it exits and Windows ends every job's processes. */
  dispose(): void
}

type Data = (chunk: Buffer | string) => void
/** The part of Node's ChildProcess this module uses. */
export type HelperChild = {
  stdin: { write(text: string): unknown; end(): unknown; on(event: 'error', fn: (err: Error) => void): unknown } | null
  stdout: { on(event: 'data', fn: Data): unknown } | null
  stderr: { on(event: 'data', fn: Data): unknown } | null
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  kill(): boolean
}
/** Node's `spawn` fits this. */
export type SpawnHelper = (
  file: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true },
) => HelperChild

/** An assign with no answer for this long is false. The first one includes PowerShell's start and the compile. */
export const ANSWER_MS = 10_000
/** A close with no answer for this long resolves anyway, so a quit never waits on a stuck helper. */
export const CLOSE_MS = 2_000

const LOG = 'openaflow desktop:'
const ID = /^[A-Za-z0-9._-]{1,128}$/
const STDERR_KEEP = 300

// C# 5: powershell.exe 5.1 compiles with the .NET Framework compiler.
const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class OpenAFlowJobs
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_SET_QUOTA = 0x0100;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static string Assign(Dictionary<string, IntPtr> jobs, string id, uint pid)
    {
        IntPtr job;
        bool made = false;
        if (!jobs.TryGetValue(id, out job))
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return "fail " + id + " " + Marshal.GetLastWin32Error();
            ExtendedLimit info = new ExtendedLimit();
            info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimit))))
            {
                int setError = Marshal.GetLastWin32Error();
                CloseHandle(job);
                return "fail " + id + " " + setError;
            }
            made = true;
        }
        int error = 0;
        IntPtr process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
        if (process == IntPtr.Zero) error = Marshal.GetLastWin32Error();
        else
        {
            if (!AssignProcessToJobObject(job, process)) error = Marshal.GetLastWin32Error();
            CloseHandle(process);
        }
        if (error != 0)
        {
            if (made) CloseHandle(job);
            return "fail " + id + " " + error;
        }
        if (made) jobs[id] = job;
        return "ok " + id;
    }

    public static void Run()
    {
        Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string[] p = line.Trim().Split(' ');
            string answer = null;
            if (p.Length == 3 && p[0] == "assign")
            {
                uint pid;
                answer = UInt32.TryParse(p[2], out pid) ? Assign(jobs, p[1], pid) : "fail " + p[1] + " 87";
            }
            else if (p.Length == 2 && p[0] == "close")
            {
                IntPtr job;
                if (jobs.TryGetValue(p[1], out job))
                {
                    TerminateJobObject(job, 1);
                    CloseHandle(job);
                    jobs.Remove(p[1]);
                }
                answer = "closed " + p[1];
            }
            if (answer != null)
            {
                Console.Out.WriteLine(answer);
                Console.Out.Flush();
            }
        }
    }
}
`

const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CSHARP}
'@
[OpenAFlowJobs]::Run()
`

/** `-EncodedCommand` takes UTF-16LE in base64. stdin stays free for the lines. */
export function helperCommand(systemRoot = process.env.SystemRoot ?? 'C:\\Windows'): { file: string; args: string[] } {
  return {
    file: `${systemRoot.replace(/\\+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
  }
}

type Request = {
  /** The answer line that settles it, minus a `fail` for an assign. */
  kind: 'assign' | 'close'
  id: string
  /** Set once the caller has its result (an answer, a timeout, or a dead helper). */
  settle: ((ok: boolean) => void) | null
}

type Helper = {
  child: HelperChild
  /** Sent and not answered yet, in send order: the helper answers in that order. Timed-out ones stay, unsettled. */
  queue: Request[]
  out: string
  err: string
  dead: boolean
}

export function createJobControl(o: { spawn: SpawnHelper; log(line: string): void; platform?: NodeJS.Platform }): JobControl {
  const onWindows = (o.platform ?? process.platform) === 'win32'
  let helper: Helper | null = null
  let disposed = false

  const finish = (r: Request, ok: boolean) => {
    const settle = r.settle
    r.settle = null
    settle?.(ok)
  }

  function onDeath(h: Helper, why: string) {
    if (h.dead) return
    h.dead = true
    if (helper === h) helper = null
    for (const r of h.queue.splice(0)) finish(r, false)
    if (disposed) return
    const tail = h.err.replace(/\s+/g, ' ').trim()
    o.log(`${LOG} job helper exited${why}${tail ? `: ${tail}` : ''}`)
  }

  function onLine(h: Helper, line: string) {
    const [word, id, code] = line.trim().split(' ')
    const head = h.queue[0]
    if (!head || head.id !== id) return
    if (head.kind === 'assign' && (word === 'ok' || word === 'fail')) {
      h.queue.shift()
      if (word === 'fail' && head.settle) o.log(`${LOG} session ${id} not in a job: error ${code ?? '?'}`)
      finish(head, word === 'ok')
    } else if (head.kind === 'close' && word === 'closed') {
      h.queue.shift()
      finish(head, true)
    }
  }

  function start(): Helper | null {
    const { file, args } = helperCommand()
    let child: HelperChild
    try {
      child = o.spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      o.log(`${LOG} job helper exited: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
    const h: Helper = { child, queue: [], out: '', err: '', dead: false }
    // A failed spawn: Node sends `error`, and maybe `exit` after it.
    child.on('error', (e) => onDeath(h, `: ${e.message}`))
    child.stdin?.on('error', () => {
      // A broken pipe: the exit that follows settles what waits.
    })
    child.stdout?.on('data', (chunk) => {
      h.out += chunk.toString()
      let nl: number
      while ((nl = h.out.indexOf('\n')) >= 0) {
        const line = h.out.slice(0, nl)
        h.out = h.out.slice(nl + 1)
        onLine(h, line)
      }
    })
    child.stderr?.on('data', (chunk) => {
      h.err = (h.err + chunk.toString()).slice(-STDERR_KEEP)
    })
    child.on('exit', (code, signal) => onDeath(h, ` (${code === null ? `signal ${signal ?? '?'}` : `code ${code}`})`))
    return h
  }

  function send(h: Helper, line: string, r: Request) {
    h.queue.push(r)
    try {
      h.child.stdin?.write(`${line}\n`)
    } catch {
      // The exit that follows settles it.
    }
  }

  return {
    assign(id, pid) {
      if (!onWindows || disposed || !ID.test(id) || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
        return Promise.resolve(false)
      }
      helper ??= start()
      const h = helper
      if (!h) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          if (!r.settle) return
          o.log(`${LOG} session ${id} not in a job: no answer in ${ANSWER_MS / 1000} s`)
          finish(r, false)
        }, ANSWER_MS)
        const r: Request = {
          kind: 'assign',
          id,
          settle: (ok) => {
            clearTimeout(timer)
            resolve(ok)
          },
        }
        send(h, `assign ${id} ${pid}`, r)
      })
    },
    close(id) {
      const h = helper
      if (!onWindows || disposed || !h || !ID.test(id)) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => finish(r, true), CLOSE_MS)
        const r: Request = {
          kind: 'close',
          id,
          settle: () => {
            clearTimeout(timer)
            resolve()
          },
        }
        send(h, `close ${id}`, r)
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      const h = helper
      helper = null
      if (!h) return
      for (const r of h.queue.splice(0)) finish(r, false)
      try {
        h.child.stdin?.end()
      } catch {
        // Already closed: the helper is gone.
      }
    },
  }
}
