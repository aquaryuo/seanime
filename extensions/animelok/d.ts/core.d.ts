declare const __isOffline__: boolean

declare function fetch(url: string, options?: FetchOptions): Promise<FetchResponse>

interface FetchOptions {
    method?: string
    headers?: Record<string, string>
    body?: any
    noCloudflareBypass?: boolean
    timeout?: number
}

interface FetchResponse {
    status: number
    statusText: string
    method: string
    rawHeaders: Record<string, string[]>
    ok: boolean
    url: string
    headers: Record<string, string>
    cookies: Record<string, string>
    redirected: boolean
    contentType: string
    contentLength: number
    text(): string
    json<T = any>(): T
}

declare function $replace<T = any>(value: T, newValue: T): void

declare function $clone<T = any>(value: T): T

declare function $toString(value: any): string

declare function $toBytes(value: any): Uint8Array

declare function $sleep(milliseconds: number): void

declare function $await<T>(promise: Promise<T>): void

declare function $arrayOf<T>(model: T): T[]

declare function $unmarshalJSON(data: any, dst: any): void

declare function $getUserPreference(key: string): string | undefined;

declare namespace $shared {
    function define<T = any>(name: string, factory: () => T): void
    function use<T = any>(name: string): T
}

declare namespace $habari {
    interface Metadata {
        season_number?: string[]
        part_number?: string[]
        title?: string
        formatted_title?: string
        anime_type?: string[]
        year?: string
        audio_term?: string[]
        device_compatibility?: string[]
        episode_number?: string[]
        other_episode_number?: string[]
        episode_number_alt?: string[]
        episode_title?: string
        file_checksum?: string
        file_extension?: string
        file_name?: string
        language?: string[]
        release_group?: string
        release_information?: string[]
        release_version?: string[]
        source?: string[]
        subtitles?: string[]
        video_resolution?: string
        video_term?: string[]
        volume_number?: string[]
    }
    function parse(filename: string): Metadata
}

declare namespace $goFeed {
    function parse(str: string): Record<string, any>
}

declare class Buffer extends ArrayBuffer {
    static poolSize: number
    constructor(arg?: string | ArrayBuffer | ArrayLike<number>, encoding?: string)
    static from(arrayBuffer: ArrayBuffer): Buffer
    static from(array: ArrayLike<number>): Buffer
    static from(string: string, encoding?: string): Buffer
    static alloc(size: number, fill?: string | number, encoding?: string): Buffer
    equals(other: Buffer | Uint8Array): boolean
    toString(encoding?: string): string
}

declare class WordArray {
    toString(encoder?: CryptoJSEncoder): string;
}

declare class CryptoJS {
    static AES: {
        encrypt: (message: string, key: string | Uint8Array, cfg?: AESConfig) => WordArray;
        decrypt: (message: string | WordArray, key: string | Uint8Array, cfg?: AESConfig) => WordArray;
    }
    static enc: {
        Utf8: CryptoJSEncoder;
        Base64: CryptoJSEncoder;
        Hex: CryptoJSEncoder;
        Latin1: CryptoJSEncoder;
        Utf16: CryptoJSEncoder;
        Utf16LE: CryptoJSEncoder;
    }
}

declare interface AESConfig {
    iv?: Uint8Array;
}

declare class CryptoJSEncoder {
    stringify(input: Uint8Array): string;
    parse(input: string): Uint8Array;
}

declare class DocSelection {
    attr(name: string): string | undefined;
    attrs(): { [key: string]: string };
    children(selector?: string): DocSelection;
    closest(selector?: string): DocSelection;
    contents(): DocSelection;
    contentsFiltered(selector: string): DocSelection;
    data<T extends string | undefined>(name?: T): T extends string ? (string | undefined) : { [key: string]: string };
    each(callback: (index: number, element: DocSelection) => void): DocSelection;
    end(): DocSelection;
    eq(index: number): DocSelection;
    filter(selector: string | ((index: number, element: DocSelection) => boolean)): DocSelection;
    find(selector: string): DocSelection;
    first(): DocSelection;
    has(selector: string): DocSelection;
    text(): string;
    html(): string | null;
    is(selector: string | ((index: number, element: DocSelection) => boolean)): boolean;
    last(): DocSelection;
    length(): number;
    map<T>(callback: (index: number, element: DocSelection) => T): T[];
    next(selector?: string): DocSelection;
    nextAll(selector?: string): DocSelection;
    nextUntil(selector: string, until?: string): DocSelection;
    not(selector: string | ((index: number, element: DocSelection) => boolean)): DocSelection;
    parent(selector?: string): DocSelection;
    parents(selector?: string): DocSelection;
    parentsUntil(selector: string, until?: string): DocSelection;
    prev(selector?: string): DocSelection;
    prevAll(selector?: string): DocSelection;
    prevUntil(selector: string, until?: string): DocSelection;
    siblings(selector?: string): DocSelection;
}

declare class Doc extends DocSelection {
    constructor(html: string);
}

declare function LoadDoc(html: string): DocSelectionFunction;

declare interface DocSelectionFunction {
    (selector: string): DocSelection;
}

declare interface $torrentUtils {
    getMagnetLinkFromTorrentData(b64: string): string
}

declare namespace $scannerUtils {
    interface NormalizedTitle {
        original: string
        normalized: string
        cleanBaseTitle: string
        denoisedTitle: string
        tokens: string[]
        season: number
        part: number
        year: number
        isMain: boolean
    }
    interface SmartSearchTitlesResult {
        titles: string[]
        season: number
        part: number
    }
    function normalizeTitle(title: string): NormalizedTitle
    function extractPartNumber(title: string): number
    function extractSeasonNumber(title: string): number
    function extractYear(title: string): number
    function compareTitles(title1: string, title2: string): number
    function findBestMatch(target: string, candidates: string[]): string
    function getSignificantTokens(title: string): string[]
    function buildSearchQuery(title: string): string
    function buildAdvancedQuery(titles: string[]): string
    function sanitizeQuery(query: string): string
    function buildSeasonQuery(title: string, season: number): string
    function buildPartQuery(title: string, part: number): string
    function buildSmartSearchTitles(titles: string[]): SmartSearchTitlesResult
}

declare interface ChromeBrowserOptions {
    timeout?: number;
    waitSelector?: string;
    waitDuration?: number;
    userAgent?: string;
    headless?: boolean;
}

declare interface NewChromeBrowserOptions {
    timeout?: number;
    userAgent?: string;
    headless?: boolean;
}

declare interface ChromeBrowser {
    navigate(url: string): Promise<void>;
    waitVisible(selector: string): Promise<void>;
    waitReady(selector: string): Promise<void>;
    click(selector: string): Promise<void>;
    sendKeys(selector: string, keys: string): Promise<void>;
    evaluate(jsCode: string): Promise<any>;
    innerHTML(selector: string): Promise<string>;
    outerHTML(selector: string): Promise<string>;
    text(selector: string): Promise<string>;
    attribute(selector: string, attributeName: string): Promise<string | null>;
    screenshot(selector: string): Promise<Uint8Array>;
    fullScreenshot(): Promise<Uint8Array>;
    sleep(milliseconds: number): Promise<void>;
    close(): Promise<void>;
}

declare class ChromeDP {
    static newBrowser(options?: NewChromeBrowserOptions): Promise<ChromeBrowser>;
    static scrape(url: string, options?: ChromeBrowserOptions): Promise<string>;
    static screenshot(url: string, options?: ChromeBrowserOptions): Promise<Uint8Array>;
    static evaluate(url: string, jsCode: string, options?: ChromeBrowserOptions): Promise<any>;
}

declare namespace $store {
    function set(key: string, value: any): void
    function get<T = any>(key: string): T
    function getUnsafe<T = any>(key: string): T
    function has(key: string): boolean
    function getOrSet<T = any>(key: string, setFunc: () => T): T
    function setIfLessThanLimit<T = any>(key: string, value: T, maxAllowedElements: number): boolean
    function unmarshalJSON(data: string): void
    function marshalJSON(value: any): string
    function reset(): void
    function values(): any[]
    function valuesUnsafe(): any[]
    function getAll(): Record<string, any>
    function getAllUnsafe(): Record<string, any>
    function watch<T = any>(key: string, callback: (value: T) => void): void
}
