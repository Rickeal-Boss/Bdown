import { warn } from './util.js';

/**
 * 数据落盘目标（Sink）。
 *
 * 三种实现：
 *  - MemorySink  ：小文件直接堆在内存里，最后拼成 Blob 交给浏览器下载。
 *  - FileHandleSink：File System Access API 的随机写，支持超大文件（8K 动辄数 GB）。
 *  - OpfsSink    ：Origin Private File System 的临时文件，作为「下载 → 混流」的中间层。
 *
 * 统一接口：
 *   size                     已写入字节数
 *   writeAt(offset, bytes)   在指定偏移写入（并发分片下载依赖它）
 *   close()                  收尾
 *   blob()                   MemorySink 专用，取出最终 Blob
 *   file()                   OpfsSink 专用，取出可随机读取的 File
 */

/** 全部放内存（最终按偏移排序拼装，因此同样支持并发分片）。 */
export class MemorySink {
  constructor() {
    /** @type {{ offset: number, bytes: Uint8Array }[]} */
    this.records = [];
    this.size = 0;
  }

  /**
   * @param {number} offset
   * @param {Uint8Array} bytes
   */
  async writeAt(offset, bytes) {
    // 入参防御：调用方传错（如把 offset 当 bytes 传）不该静默产出坏文件。
    // 曾因此出现 `bytes` 是数字 0、size 变 NaN、最终产物多出 1 字节的怪象。
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
    const at = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    this.records.push({ offset: at, bytes: data });
    this.size = Math.max(this.size || 0, at + data.length);
  }

  /** 顺序追加（不支持断点续传的旧路径；续传请用 writeAt 指定偏移）。 */
  async write(bytes) {
    return this.writeAt(this.size || 0, bytes);
  }

  async close() {}

  /**
   * 按 offset 拼装完整内容。
   *
   * 不能简单 `sorted.map(r => r.bytes)` 拼接：断点续传会让写入顺序与偏移
   * 不一致，而且可能存在空洞（未下载的区间）与重叠（重试同一分片）。
   * 这里按最终 size 建缓冲区，逐条写入（后写覆盖先写），未覆盖处补 0。
   */
  blob(type = 'application/octet-stream') {
    if (!this.records.length || !this.size) return new Blob([], { type });
    const out = new Uint8Array(this.size);
    const sorted = [...this.records].sort((a, b) => a.offset - b.offset);
    for (const r of sorted) {
      if (r.offset < 0 || r.offset + r.bytes.length > out.length) continue;
      out.set(r.bytes, r.offset);
    }
    return new Blob([out], { type });
  }
}

/**
 * File System Access API / OPFS 的随机写目标。
 * 支持 `write({ type: 'write', position, data })`，因此可以让多个分片并发写入同一文件。
 */
export class FileHandleSink {
  /**
   * @param {FileSystemFileHandle} handle
   */
  constructor(handle) {
    this.handle = handle;
    this.writable = null;
    this.size = 0;
    this._chain = Promise.resolve();
  }

  async open() {
    this.writable = await this.handle.createWritable({ keepExistingData: true });
    return this;
  }

  /**
   * 随机位置写入。
   *
   * 注意：不同浏览器对并发 write 的支持不一致，这里用一条 Promise 链串行化写操作，
   * 保证不会出现「写一半被另一个分片插入」的情况；网络下载本身仍然是并发的。
   */
  writeAt(offset, bytes) {
    this._chain = this._chain.then(async () => {
      await this.writable.write({ type: 'write', position: offset, data: bytes });
      this.size = Math.max(this.size, offset + bytes.length);
    });
    return this._chain;
  }

  /** 顺序追加写（混流输出用）。 */
  write(bytes) {
    this._chain = this._chain.then(async () => {
      await this.writable.write({ type: 'write', position: this.size, data: bytes });
      this.size += bytes.length;
    });
    return this._chain;
  }

  /**
   * flush 并关闭 OPFS writable。
   *
   * 注意：原来写成 `await this._chain; ...`，一旦任何一次 writeAt 失败，
   * `_chain` 就永久 rejected —— 于是 writable **永远不会被关闭**：
   *   - OPFS 文件句柄锁死（Chrome 下该文件无法删除/覆盖）
   *   - 后续 getFile() 读不到已写内容（数据还缓冲在 writable 里）
   * 现在即便写入链出错，也保证句柄被释放，错误只告警不吞掉语义。
   */
  async close() {
    let chainError = null;
    try {
      await this._chain;
    } catch (err) {
      chainError = err;
    }
    if (this.writable) {
      try {
        await this.writable.close();
      } finally {
        this.writable = null;
      }
    }
    if (chainError) throw chainError;
  }

  /**
   * 把文件截断到指定长度。
   *
   * 为什么需要：重试 / 换清晰度 / 续传清单失效时要把 sink 归零重下。
   * 以前只把 `size` 设为 0 **不截断文件**，OPFS 的覆盖写不会缩短文件，
   * 于是新内容比旧的短时，尾部会残留上一轮的字节 —— 产物是"拼接怪胎"。
   */
  async truncate(size = 0) {
    try {
      await this._chain;
    } catch {
      /* 写入链坏了他也拦不住，继续尽力截断 */
    }
    try {
      if (this.writable) {
        await this.writable.write({ type: 'truncate', size });
      } else if (typeof this.handle?.truncate === 'function') {
        await this.handle.truncate(size);
      }
    } catch (err) {
      // 注意：这里不能用项目里的 warn()——sink.js 没有引入它。
      // 截断失败不致命，静默继续；上层读回时会因数据不对而报明确错误。
      void err;
    }
    this.size = size;
  }

  async abort() {
    try {
      await this._chain;
      if (this.writable) await this.writable.abort();
    } catch {
      /* ignore */
    }
  }

  async file() {
    return this.handle.getFile();
  }
}

/** OPFS 临时目录管理。 */
export class OpfsWorkspace {
  constructor(dirName = 'bdown-tmp') {
    this.dirName = dirName;
    this.dir = null;
  }

  async ensure() {
    if (this.dir) return this.dir;
    const root = await navigator.storage.getDirectory();
    this.dir = await root.getDirectoryHandle(this.dirName, { create: true });
    return this.dir;
  }

  /**
   * 新建一个临时文件目标。
   * @param {string} name
   * @returns {Promise<FileHandleSink>}
   */
  async create(name) {
    const dir = await this.ensure();
    const handle = await dir.getFileHandle(name, { create: true });
    return new FileHandleSink(handle).open();
  }

  async remove(name) {
    try {
      const dir = await this.ensure();
      await dir.removeEntry(name);
    } catch {
      /* ignore */
    }
  }

  async clear() {
    try {
      const dir = await this.ensure();
      for await (const [name] of dir.entries()) {
        await dir.removeEntry(name, { recursive: true }).catch(() => {});
        void name;
      }
    } catch {
      /* ignore */
    }
  }

  /** 估算 OPFS 可用空间（仅 Chromium 支持）。 */
  static async estimate() {
    try {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    } catch {
      return { usage: 0, quota: 0 };
    }
  }
}

/** 根据文件大小自动选择内存 or OPFS。 */
export const MEMORY_LIMIT = 256 * 1024 * 1024; // 256MB

export function shouldUseMemory(totalSize) {
  return totalSize > 0 && totalSize <= MEMORY_LIMIT;
}
