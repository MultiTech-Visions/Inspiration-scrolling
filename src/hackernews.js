'use strict';

const USER_AGENT = 'inspiration-scrolling/0.1';

// Algolia HN search — keyword search over stories, returns hits with author,
// points, num_comments, created_at_i, story_id, title, url.
async function searchStories(query, { maxResults = 8, minPoints = 20 } = {}) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('searchStories requires a query string');
  }
  const url = new URL('https://hn.algolia.com/api/v1/search');
  url.searchParams.set('query', query);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('numericFilters', `points>${minPoints}`);
  url.searchParams.set('hitsPerPage', String(Math.min(maxResults * 2, 50)));

  const res = await fetch(url.toString(), { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HN search ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json.hits)) {
    throw new Error('HN search response missing hits array');
  }
  return json.hits
    .filter((h) => h.url && h.title)
    .slice(0, maxResults)
    .map((h) => ({
      id: String(h.objectID),
      title: h.title,
      url: h.url,
      points: h.points || 0,
      author: h.author || null,
      comments: h.num_comments || 0,
      created_at: h.created_at,
    }));
}

module.exports = { searchStories };
