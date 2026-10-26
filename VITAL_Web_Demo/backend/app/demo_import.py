"""Import article text and ordered image blocks without executing remote HTML."""

import asyncio
import ipaddress
import json
import socket
from io import BytesIO
from pathlib import Path
from urllib.parse import urljoin, urlparse
from uuid import uuid4

import httpx
from bs4 import BeautifulSoup
from PIL import Image

Image.MAX_IMAGE_PIXELS = 20_000_000
EXCLUDED = "script,style,nav,footer,form,[aria-hidden='true'],[role='navigation'],.advertisement,.ad-slot,.related-content"


async def public_url(url):
    parsed = urlparse(url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Use a public http or https article URL.")
    if parsed.port not in {None, 80, 443}:
        raise ValueError("Only standard web ports are supported.")
    addresses = await asyncio.to_thread(
        socket.getaddrinfo,
        parsed.hostname,
        parsed.port or (443 if parsed.scheme == "https" else 80),
    )
    if not addresses or any(
        not ipaddress.ip_address(item[4][0]).is_global for item in addresses
    ):
        raise ValueError("Private and local network addresses cannot be imported.")
    return url


async def download(url, max_bytes=10_000_000):
    async with httpx.AsyncClient(
        timeout=25, follow_redirects=False, trust_env=False
    ) as client:
        for _ in range(5):
            await public_url(url)
            async with client.stream(
                "GET",
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (compatible; VITAL/1.3; article snapshots)",
                    "Accept": "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5",
                },
            ) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    url = urljoin(url, response.headers.get("location", ""))
                    continue
                if response.status_code in {401, 403}:
                    raise ValueError(
                        "This site blocked the import or requires sign-in. Paste the article text manually."
                    )
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise ValueError("The downloaded file is too large.")
                return bytes(body), response.headers.get("content-type", ""), url
    raise ValueError("Too many redirects.")


def image_snapshot(data, directory):
    if len(data) > 8_000_000:
        raise ValueError("Choose an image smaller than 8 MB.")
    Path(directory).mkdir(parents=True, exist_ok=True)
    with Image.open(BytesIO(data)) as image:
        image.load()
        image.thumbnail((1600, 1600))
        image = image.convert("RGB")
        name = f"{uuid4().hex}.jpg"
        image.save(Path(directory) / name, "JPEG", quality=88)
    return f"/media/{name}"


def image_address(node, url):
    source = (
        node.get("data-src") or node.get("data-original") or node.get("data-lazy-src")
    )
    srcset = node.get("data-srcset") or node.get("srcset")
    if not srcset and node.parent and node.parent.name == "picture":
        picture_source = node.parent.find("source")
        srcset = picture_source.get("srcset") if picture_source else None
    if not source and srcset:
        source = srcset.split(",")[-1].strip().split()[0]
    source = source or node.get("src") or ""
    if not source or source.startswith(("data:", "blob:")):
        return ""
    address = urljoin(url, source)
    return address if urlparse(address).scheme in {"http", "https"} else ""


def parse_article(html, url):
    soup = BeautifulSoup(html, "html.parser")

    def meta(*names):
        for name in names:
            item = soup.find("meta", attrs={"property": name}) or soup.find(
                "meta", attrs={"name": name}
            )
            if item and item.get("content"):
                return item["content"].strip()
        return ""

    structured, embedded_bodies = [], []

    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            kinds = value.get("@type", [])
            kinds = [kinds] if isinstance(kinds, str) else kinds
            if any(
                kind
                in {"NewsArticle", "Article", "BlogPosting", "ReportageNewsArticle"}
                for kind in kinds
            ):
                structured.append(value)
            if isinstance(value.get("articleBody"), str):
                embedded_bodies.append(value["articleBody"])
            for item in value.values():
                if isinstance(item, (list, dict)):
                    walk(item)

    for script in soup.select(
        'script[type="application/ld+json"],script[type="application/json"],script#__NEXT_DATA__'
    ):
        try:
            walk(json.loads(script.string or script.get_text()))
        except (ValueError, TypeError, RecursionError):
            pass
    article = max(
        structured, key=lambda item: len(str(item.get("articleBody", ""))), default={}
    )
    title = (
        article.get("headline")
        or meta("og:title", "twitter:title")
        or (soup.h1.get_text(" ", strip=True) if soup.h1 else "")
    )
    language = (soup.html.get("lang", "en") if soup.html else "en").split("-")[0]
    for item in soup.select(EXCLUDED):
        item.decompose()
    candidates = soup.select(
        "[itemprop='articleBody'],.article__content,.article-body,.article-content,article,main,[role='main']"
    )

    def score(root):
        paragraphs = root.select("p,blockquote,[data-component='text-block']")
        return sum(
            len(item.get_text())
            for item in paragraphs
            if not item.find_parent(["nav", "footer"])
        )

    root = max(candidates, key=score, default=soup.body or soup)
    if score(root) < 40:
        root = soup.body or soup
    blocks, seen_text, seen_images = [], set(), set()
    for item in root.select("p,h2,h3,li,blockquote,img,[data-component='text-block']"):
        if item.name == "img":
            address = image_address(item, url)
            if (
                not address
                or address in seen_images
                or item.get("width") == "1"
                or item.get("height") == "1"
            ):
                continue
            seen_images.add(address)
            figure = item.find_parent("figure")
            caption = figure.find("figcaption") if figure else None
            blocks.append(
                {
                    "type": "image",
                    "url": address,
                    "alt": item.get("alt", ""),
                    "caption": caption.get_text(" ", strip=True) if caption else "",
                }
            )
            continue
        # Prevent repeated blockquote/list text, while keeping short paragraphs.
        if item.find_parent(["p", "li", "blockquote"]):
            continue
        text = item.get_text(" ", strip=True)
        if text and text not in seen_text:
            seen_text.add(text)
            blocks.append(
                {
                    "type": "heading" if item.name in {"h2", "h3"} else "paragraph",
                    "text": text,
                }
            )
    text = "\n\n".join(block["text"] for block in blocks if block["type"] != "image")
    alternatives = [("structured data", body) for body in embedded_bodies]
    try:
        import trafilatura

        extracted = trafilatura.extract(
            html, url=url, include_comments=False, include_tables=True
        )
        if extracted:
            alternatives.append(("article extraction", extracted))
    except (ImportError, ValueError):
        pass
    method = "article HTML"
    for name, candidate in alternatives:
        candidate = (
            BeautifulSoup(candidate, "html.parser").get_text("\n", strip=True)
            if "<p" in candidate
            else candidate.strip()
        )
        if len(candidate) > len(text) * 1.35:
            # Retain images and anchor them to matching preceding text where possible.
            images = []
            preceding = ""
            for block in blocks:
                if block["type"] == "image":
                    images.append((preceding, block))
                else:
                    preceding = block["text"]
            blocks = [
                {"type": "paragraph", "text": paragraph.strip()}
                for paragraph in candidate.splitlines()
                if paragraph.strip()
            ]
            for anchor, image in images:
                at = next(
                    (
                        index + 1
                        for index, block in enumerate(blocks)
                        if anchor and anchor in block.get("text", "")
                    ),
                    len(blocks),
                )
                blocks.insert(at, image)
            text = "\n\n".join(
                block["text"] for block in blocks if block["type"] != "image"
            )
            method = name
    author = article.get("author", "")
    if isinstance(author, list):
        author = ", ".join(
            item.get("name", "") if isinstance(item, dict) else str(item)
            for item in author
        )
    elif isinstance(author, dict):
        author = author.get("name", "")
    image = article.get("image", "")
    if isinstance(image, list):
        image = image[0] if image else ""
    if isinstance(image, dict):
        image = image.get("url", "")
    image = image or meta("og:image", "twitter:image")
    publisher = article.get("publisher", {})
    publisher = (
        publisher.get("name", "") if isinstance(publisher, dict) else str(publisher)
    )
    warnings = []
    if len(text) < 120:
        warnings.append(
            "Little article text was found. The site may require sign-in or JavaScript. Paste the text manually."
        )
    if len(text) > 120000:
        warnings.append(
            "The article exceeds the demo text limit. Use a shorter article."
        )
    return {
        "title": str(title)[:1000],
        "text": text[:120000],
        "blocks": blocks,
        "url": url,
        "author": str(author or meta("author"))[:500],
        "publisher": str(publisher or meta("og:site_name") or urlparse(url).hostname)[
            :200
        ],
        "published_at": str(
            article.get("datePublished") or meta("article:published_time", "date")
        )[:100],
        "image_url": urljoin(url, str(image)) if image else "",
        "language": language,
        "theme": "other",
        "visible": False,
        "rights_confirmed": False,
        "warnings": warnings,
        "import_method": method,
    }


async def import_article(url, directory):
    body, content_type, final_url = await download(url)
    if "html" not in content_type.lower():
        raise ValueError("That URL does not return an HTML article.")
    data = await asyncio.to_thread(parse_article, body, final_url)
    data["original_image_url"] = data["image_url"]
    urls = list(
        dict.fromkeys(
            [data["image_url"]]
            + [block["url"] for block in data["blocks"] if block["type"] == "image"]
        )
    )
    urls = [url for url in urls if url]
    slots = asyncio.Semaphore(4)

    async def copy(address):
        async with slots:
            try:
                image, kind, _ = await download(address, 8_000_000)
                if not kind.lower().startswith("image/"):
                    return address, ""
                return address, await asyncio.to_thread(
                    image_snapshot, image, directory
                )
            except Exception:
                return address, ""

    # Prevent an imported gallery from consuming unlimited disk and network resources.
    results = dict(await asyncio.gather(*(copy(address) for address in urls[:60])))
    if len(urls) > 60:
        data["warnings"].append("Only the first 60 article images were copied.")
    failed = sum(not results.get(address) for address in urls)
    if failed:
        data["warnings"].append(f"{failed} article image(s) could not be copied.")
    data["image_url"] = results.get(data["image_url"], "")
    kept = []
    for block in data["blocks"]:
        if block["type"] == "image":
            local = results.get(block["url"])
            if not local:
                continue
            block = {**block, "url": local}
            # The hero is already shown above the article body.
            if local == data["image_url"]:
                continue
        kept.append(block)
    data["blocks"] = kept
    return data
