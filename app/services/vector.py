import hashlib
import math
import re
from pathlib import Path


def chunk_text(text: str, chunk_size: int = 900, overlap: int = 150) -> list[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return []

    if overlap >= chunk_size:
        overlap = max(0, chunk_size // 4)

    chunks: list[str] = []
    start = 0
    length = len(normalized)
    while start < length:
        end = min(length, start + chunk_size)
        piece = normalized[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= length:
            break
        start = max(0, end - overlap)
    return chunks


def cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    if not vec_a or not vec_b:
        return 0.0
    if len(vec_a) != len(vec_b):
        return 0.0

    dot = sum(a * b for a, b in zip(vec_a, vec_b, strict=True))
    norm_a = math.sqrt(sum(a * a for a in vec_a))
    norm_b = math.sqrt(sum(b * b for b in vec_b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class EmbeddingService:
    def __init__(self, model_path: str | None = None, fallback_dim: int = 384):
        self.model_path = model_path
        self.fallback_dim = fallback_dim
        self.backend = "hash-fallback"
        self._model = None
        self._try_load_llama_backend()

    def _try_load_llama_backend(self) -> None:
        if not self.model_path:
            return
        path = Path(self.model_path)
        if not path.is_file():
            return

        try:
            from llama_cpp import Llama
        except Exception:
            return

        try:
            self._model = Llama(
                model_path=str(path),
                embedding=True,
                n_ctx=2048,
                verbose=False,
            )
            self.backend = "llama-cpp"
        except Exception:
            self._model = None

    def _hash_embed(self, text: str) -> list[float]:
        tokens = re.findall(r"[a-zA-Z0-9_]+", text.lower())
        if not tokens:
            return [0.0] * self.fallback_dim

        vector = [0.0] * self.fallback_dim
        for token in tokens:
            digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
            idx = int(digest[:8], 16) % self.fallback_dim
            sign = -1.0 if int(digest[8:10], 16) % 2 else 1.0
            vector[idx] += sign

        norm = math.sqrt(sum(value * value for value in vector))
        if norm == 0:
            return vector
        return [value / norm for value in vector]

    def encode(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        if self._model is None:
            return [self._hash_embed(text) for text in texts]

        try:
            response = self._model.create_embedding(input=texts)
            data = response.get("data", [])
            embeddings = [item["embedding"] for item in sorted(data, key=lambda x: x["index"])]
            if len(embeddings) == len(texts):
                return embeddings
        except Exception:
            pass

        return [self._hash_embed(text) for text in texts]

