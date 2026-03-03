from urllib.parse import quote

import requests


def fetch_wikipedia_article(title: str, lang: str = "en", timeout: int = 20) -> dict[str, str]:
    endpoint = f"https://{lang}.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "format": "json",
        "prop": "extracts",
        "explaintext": 1,
        "redirects": 1,
        "titles": title,
    }
    response = requests.get(endpoint, params=params, timeout=timeout)
    response.raise_for_status()
    payload = response.json()
    pages = payload.get("query", {}).get("pages", {})

    if not pages:
        raise ValueError(f"Could not find article for title '{title}'")

    page = next(iter(pages.values()))
    article_title = page.get("title", title)
    extract = (page.get("extract") or "").strip()
    if not extract:
        raise ValueError(f"Wikipedia article '{article_title}' is empty or missing")

    url_title = quote(article_title.replace(" ", "_"), safe="_")
    return {
        "title": article_title,
        "content": extract,
        "url": f"https://{lang}.wikipedia.org/wiki/{url_title}",
    }

