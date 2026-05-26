import { BaseProvider } from 'seanime-core';

export default class AnikototvProvider extends BaseProvider {
  constructor() {
    super('anikototv', 'Anikototv');
    this.baseUrl = 'https://anikototv.to';
    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Referer': 'https://anikototv.to'
    };
  }

  async search(query: string) {
    const searchUrl = `${this.baseUrl}/filter?keyword=${encodeURIComponent(query)}`;
    
    const html = await this.request(searchUrl);
    const doc = this.parseHTML(html);
    const animeList: any[] = [];

    const items = doc.querySelectorAll('.item');

    items.forEach((item) => {
      const linkElement = item.querySelector('.inner .poster a');
      if (linkElement) {
        animeList.push({
          subOrDub: 'sub',
          id: linkElement.href,
          title: linkElement.textContent.trim(),
          url: '',
        });
      }
    });

    return animeList;
  }

  async getEpisodes(animeUrl: string) {
    const html = await this.request(animeUrl);
    const doc = this.parseHTML(html);
    const episodes: any[] = [];

    const episodeItems = doc.querySelectorAll('ul.ep-range li');

    episodeItems.forEach((item) => {
      const linkElement = item.querySelector('a');
      if (linkElement) {
        const titleElement = linkElement.querySelector('span.d-title');
        const episodeTitle = titleElement ? titleElement.textContent.trim() : linkElement.textContent.trim();

        episodes.push({
          id: linkElement.href,
          number: 1,
          title: episodeTitle,
          url: linkElement.href,
        });
      }
    });

    if (episodes.length === 0) throw new Error('No episodes found.');

    return episodes;
  }

  async getVideoUrl(episodeUrl: string) {
    const html = await this.request(episodeUrl);
    const doc = this.parseHTML(html);

    // Get the iframe URL (Megaplay player)
    const iframe = doc.querySelector('iframe');
    if (!iframe || !iframe.src) {
      throw new Error('Failed to find video player iframe.');
    }

    // The iframe src is the actual video source
    const videoUrl = iframe.src;

    return {
      videoSources: [
        {
          url: videoUrl,
          type: 'hls',
          quality: '1080p',
          subtitles: [],
          headers: { Referer: 'https://megaplay.buzz/' },
        },
      ],
      headers: { Referer: this.baseUrl },
      server: 'Megaplay',
    };
  }
}
