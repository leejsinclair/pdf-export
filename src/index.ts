import { spawn, ChildProcess } from 'child_process';
import CDP = require('chrome-remote-interface');

const timeout = async (mis: number) => new Promise(resolve => setTimeout(resolve, mis));

interface IPDFExportOptions extends CDP.ICDPOptions {
  chromeBin: string,
  chromBinOptions: Array<string>,
  timeout?: number,
};

export default class PDFExport {
  private options: IPDFExportOptions = null;
  constructor(options: IPDFExportOptions) {
    this.options = options;
    this.options.timeout = this.options.timeout || 3000;
  }

  static _chromeProcessPromise: Promise<ChildProcess> = null;
  private async spawnChrome(): Promise<ChildProcess> {
    if (PDFExport._chromeProcessPromise === null) {
      PDFExport._chromeProcessPromise = new Promise(async resolve => {
        const chromeBinOptions = this.options.chromBinOptions || [];
        let options = [
          `--remote-debugging-port=${this.options.port}`,
          '--disable-extensions',
          '--headless',...chromeBinOptions
        ];
        const p = spawn(this.options.chromeBin, options);
        p.stdout.pipe(process.stdout);
        p.stderr.pipe(process.stderr);
        let started = false;
        // 通过尝试连接端口，探测chrome是否启动成功
        while (!started) {
          try {
            await timeout(200);
            const client = await CDP(this.options);
            started = true;
            client.close();
            resolve(p);
          } catch (e) {}
        }
      });
    }
    return PDFExport._chromeProcessPromise;
  }

  private injectDetectScript(client: CDP.ICDPClient): Promise<any> {
    return client.Page.addScriptToEvaluateOnLoad({
      scriptSource: `
        window.__pageRenderFinishedPromise__ = new Promise(function(resolve) {
          window.__notifyPageRenderFinished__ = resolve;
        });
      `
    });
  }

  /**
   * 等待__notifyPageRenderFinished__被调用，或者5秒钟超时
   *
   * @private
   * @param {CDP.ICDPClient} client
   * @returns {Promise<any>}
   * @memberof PDFExport
   */
  private waitForRenderFinished(client: CDP.ICDPClient): Promise<any> {
    return Promise.race([
      client.Runtime.evaluate({
        expression: `new Promise(function(resolve) {
          setTimeout(function () {
            window.__pageRenderFinishedPromise__.then(resolve);
          });
        })`,
        awaitPromise: true,
      }).then(() => 'page render finished callback.'),
      timeout(this.options.timeout).then(() => 'timeout for waiting rendering.'),
    ]).then(console.log);
  }

  private async setClientCookies(client: CDP.ICDPClient, cookies: CDP.ICookieItem[]) {
    await client.Network.clearBrowserCookies();
    await Promise.all(cookies.map(cookieItem =>
      client.Network.setCookie(cookieItem),
    ));
  }
  /**
   * 导出url指向的网页
   *
   * @param {string} url
   * @returns {Promise<Buffer>}
   * @memberof PDFExport
   */
  public async export(options: {
    url: string,
    cookies?: CDP.ICookieItem[],
    pdfOptions?: CDP.IPrintToPDFOptions,
  }): Promise<Buffer> {
    if (!options.url) {
      throw new Error('options.url is required');
    }
    options.cookies = options.cookies || [];
    await this.spawnChrome();
    const { host, port } = this.options;
    const target = await CDP.New({ host, port });
    const client = await CDP({ host, port, target });
    try {
      await Promise.all([
        client.Security.enable(),
        client.Page.enable(),
        client.Network.enable(),
        client.Runtime.enable(),
      ]);

      await client.Security.setOverrideCertificateErrors({ override: true });
      client.Security.certificateError().then(({ eventId }) => {
        client.Security.handleCertificateError({ eventId, action: 'continue' });
      });
      await this.setClientCookies(client, options.cookies || []);
      await this.injectDetectScript(client);
      await client.Page.navigate({ url: options.url });
      await client.Page.loadEventFired();
      await this.waitForRenderFinished(client);
      const base64Data = await client.Page.printToPDF(options.pdfOptions);
      const buffer = Buffer.from(base64Data.data, 'base64');
      return buffer;
    } catch(e) {
      console.log(e);
      return null;
    } finally {
      await client.close();
      await CDP.Close({ host, port, id: target.id });
    }
  }

  /**
   * 清理资源
   */
  public async dispose() {
    const chromeProcess = await PDFExport._chromeProcessPromise;
    chromeProcess.kill();
  }
}
