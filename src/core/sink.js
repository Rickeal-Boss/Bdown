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

  async writeAt(offset, bytes) {
    this.records.push({ offset, bytes });
    this.size = Math.max(this.size, offset + bytes.length);
  }

  async write(bytes) {
    return this.writeAt(this.size, bytes);
  }

  async close() {}

  blob(type = 'application/octet-stream') {
    const sorted = [...this.records].sort((a, b) => a.offset - b.offset);
    return new Blob(sorted.map((r) => r.bytes), { type });
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

  async close() {
    await this._chain;
    if (this.writable) {
      await this.writable.close();
      this.writable = null;
    }
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
