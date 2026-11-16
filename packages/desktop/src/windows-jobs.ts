// Windows Job Objects for hosted sessions: one job per session, with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so closing
// the job ends the session's program and every child it started, detached ones too: those it started after the
// assign join on their own, and the helper puts the ones it started before in the job at the assign. No native
// dependency: one hidden `powershell.exe` child of main compiles a small C# class with `Add-Type` and holds the job
// handles. When that helper ends (its stdin closes, or it is killed), Windows closes its handles, so every job's
// processes end too. No `electron` import: the glue passes Node's `spawn`. The rules are in
// pod-docs/sprints/session-life.md (§7, J1).
//
// Lines, one request at a time, answered in order:
//   main → helper: `assign <id> <pid> [<since>]`  `close <id>`
//   helper → main: `ok <id> <joined>`  `fail <id> <win32 error> <call> <joined>`  `closed <id>`
// `since`: Unix ms, less BIRTH_SLACK_MS, when main asked the host for the session; nothing the session started is
// older. `call`: the Win32 call that failed.
// `joined`: how many processes the session's program started before the assign, and their children, the helper put in
// the job after it. Without that, a child started while the helper was still starting stays outside the job (CI,
// session-life wave 3): close and the helper's exit never end it, and once its parent has ended, taskkill /T can't
// find it either. `close` puts such children in the job once more before it ends the job.
// A `fail` keeps the job when the helper made it: the program's own children join it, found by their parent pid even
// when the program is gone (`OpenProcess` error 87: a program that ended with its crashed host before the cold
// helper's first assign, CI run 43779514743). Only a process born after `since` counts as the gone program's child,
// so a stranger's orphan never joins.

export type JobControl = {
  /**
   * Puts a running process in the session's job. `since`: when main asked for the session (Unix ms). False on any
   * failure: the caller falls back to a tree kill.
   */
  assign(id: string, pid: number, since?: number): Promise<boolean>
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
/** Taken off `since`: Windows may stamp a process's start up to a clock tick before Node's clock reads it. */
export const BIRTH_SLACK_MS = 1_000

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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_SET_QUOTA = 0x0100;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TH32CS_SNAPPROCESS = 0x0002;

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
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW", ExactSpelling = true)]
    static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32NextW", ExactSpelling = true)]
    static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);

    const int JobObjectBasicProcessIdList = 3;
    const int MEMBERS_MAX = 4096;
    // Passes of JoinEarlier: a process outside the job may start another one between two passes.
    const int JOIN_PASSES = 5;

    // A session's job, its program's pid, and that program's start time; when the program was gone at the assign,
    // the time main gave (since), or 0 when main gave none.
    class Job
    {
        public IntPtr Handle;
        public uint Root;
        public long Born;
    }

    // Unix ms to Windows' FILETIME, the unit of GetProcessTimes.
    static long FromUnixMs(long ms)
    {
        return (ms + 11644473600000L) * 10000L;
    }

    // A process's start time, or -1 when it is gone or can't be read.
    static long Started(uint pid)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return -1;
        long creation, exit, kernel, user;
        bool read = GetProcessTimes(process, out creation, out exit, out kernel, out user);
        CloseHandle(process);
        return read ? creation : -1;
    }

    // The processes that descend from root now, by parent pid. born: root's start time, as the job recorded it. A
    // process that started before the parent it names is the child of an earlier holder of that pid, and is left out
    // with its own children. When root is gone, its children still name it; when a later process holds root's pid
    // now, root's own children are the ones born before that process.
    static List<uint> Descendants(uint root, long born)
    {
        List<uint> found = new List<uint>();
        if (born <= 0) return found;
        long holder = Started(root);
        long until = holder < 0 || holder == born ? long.MaxValue : holder;
        List<uint> pids = new List<uint>();
        List<uint> parents = new List<uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) return found;
        ProcessEntry entry = new ProcessEntry();
        entry.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry));
        bool more = Process32First(snapshot, ref entry);
        while (more)
        {
            pids.Add(entry.th32ProcessID);
            parents.Add(entry.th32ParentProcessID);
            more = Process32Next(snapshot, ref entry);
        }
        CloseHandle(snapshot);
        Dictionary<uint, long> start = new Dictionary<uint, long>();
        start[root] = born;
        Queue<uint> todo = new Queue<uint>();
        todo.Enqueue(root);
        while (todo.Count > 0)
        {
            uint parent = todo.Dequeue();
            for (int i = 0; i < pids.Count; i++)
            {
                uint pid = pids[i];
                if (parents[i] != parent || pid == 0 || start.ContainsKey(pid)) continue;
                long at = Started(pid);
                if (at < 0 || at < start[parent] || (parent == root && at >= until)) continue;
                start[pid] = at;
                found.Add(pid);
                todo.Enqueue(pid);
            }
        }
        return found;
    }

    // Puts in the job each of root's descendants that is not in it: the ones root started before it joined the job,
    // and theirs. What root starts after it joined is in the job already. Answers how many joined.
    static int JoinEarlier(IntPtr job, uint root, long born)
    {
        int joined = 0;
        for (int pass = 0; pass < JOIN_PASSES; pass++)
        {
            int added = 0;
            foreach (uint pid in Descendants(root, born))
            {
                IntPtr process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (process == IntPtr.Zero) continue;
                bool inJob;
                if (IsProcessInJob(process, job, out inJob) && !inJob && AssignProcessToJobObject(job, process)) added++;
                CloseHandle(process);
            }
            joined += added;
            if (added == 0) break;
        }
        return joined;
    }

    // The pids in the job now.
    static List<uint> Members(IntPtr job)
    {
        List<uint> list = new List<uint>();
        // Two counts, then the pid list, one pointer-sized entry each.
        int size = 8 + IntPtr.Size * MEMBERS_MAX;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)size, IntPtr.Zero)) return list;
            int count = Marshal.ReadInt32(buffer, 4);
            for (int i = 0; i < count && i < MEMBERS_MAX; i++) list.Add((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return list;
    }

    static string Fail(string id, int error, string call, int joined)
    {
        return "fail " + id + " " + error + " " + call + " " + joined;
    }

    // floor: FILETIME of main's since, or 0.
    static string Assign(Dictionary<string, Job> jobs, string id, uint pid, long floor)
    {
        Job record;
        IntPtr job;
        long started = Started(pid);
        long born = started >= 0 ? started : floor;
        if (jobs.TryGetValue(id, out record)) job = record.Handle;
        else
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return Fail(id, Marshal.GetLastWin32Error(), "CreateJobObject", 0);
            ExtendedLimit info = new ExtendedLimit();
            info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimit))))
            {
                int setError = Marshal.GetLastWin32Error();
                CloseHandle(job);
                return Fail(id, setError, "SetInformationJobObject", 0);
            }
            record = new Job();
            record.Handle = job;
            record.Root = pid;
            record.Born = born;
            jobs[id] = record;
        }
        int error = 0;
        string call = null;
        IntPtr process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
        if (process == IntPtr.Zero)
        {
            error = Marshal.GetLastWin32Error();
            call = "OpenProcess";
        }
        else
        {
            if (!AssignProcessToJobObject(job, process))
            {
                error = Marshal.GetLastWin32Error();
                call = "AssignProcessToJobObject";
            }
            CloseHandle(process);
        }
        // Kept on a fail too: what the program started joins, and close or the helper's exit ends it.
        int joined = JoinEarlier(job, pid, born);
        return error != 0 ? Fail(id, error, call, joined) : "ok " + id + " " + joined;
    }

    public static void Run()
    {
        Dictionary<string, Job> jobs = new Dictionary<string, Job>();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string[] p = line.Trim().Split(' ');
            string answer = null;
            if ((p.Length == 3 || p.Length == 4) && p[0] == "assign")
            {
                uint pid;
                long since;
                long floor = p.Length == 4 && Int64.TryParse(p[3], out since) && since > 0 ? FromUnixMs(since) : 0;
                answer = UInt32.TryParse(p[2], out pid) ? Assign(jobs, p[1], pid, floor) : Fail(p[1], 87, "parse", 0);
            }
            else if (p.Length == 2 && p[0] == "close")
            {
                Job record;
                if (jobs.TryGetValue(p[1], out record))
                {
                    // A child that a process outside the job started after the assign's last pass, and one of a
                    // program that never joined.
                    JoinEarlier(record.Handle, record.Root, record.Born);
                    foreach (uint member in Members(record.Handle)) JoinEarlier(record.Handle, member, Started(member));
                    TerminateJobObject(record.Handle, 1);
                    CloseHandle(record.Handle);
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
  /** When main sent it. */
  at: number
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
    const [word, id, code, call, joinedText] = line.trim().split(' ')
    const head = h.queue[0]
    if (!head || head.id !== id) return
    if (head.kind === 'assign' && (word === 'ok' || word === 'fail')) {
      h.queue.shift()
      if (word === 'fail' && head.settle) {
        const joined = Number(joinedText ?? 0)
        const note = joined > 0 ? `; ${joined} processes it started joined its job` : ''
        o.log(`${LOG} session ${id} not in a job: error ${code ?? '?'}${call ? ` at ${call}` : ''}${note}`)
      }
      if (word === 'ok' && head.settle) {
        const joined = Number(code ?? 0)
        const note = joined > 0 ? `; ${joined} processes it started before joined too` : ''
        o.log(`${LOG} session ${id} in a job after ${Date.now() - head.at} ms${note}`)
      }
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
    assign(id, pid, since) {
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
          at: Date.now(),
          settle: (ok) => {
            clearTimeout(timer)
            resolve(ok)
          },
        }
        const floor = since !== undefined && Number.isSafeInteger(since) && since > BIRTH_SLACK_MS ? ` ${since - BIRTH_SLACK_MS}` : ''
        send(h, `assign ${id} ${pid}${floor}`, r)
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
          at: Date.now(),
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
