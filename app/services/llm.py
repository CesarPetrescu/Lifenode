from pathlib import Path


class LocalLlmService:
    def __init__(self, model_path: str | None = None):
        self.model_path = model_path
        self.backend = "context-fallback"
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
                n_ctx=4096,
                n_threads=4,
                verbose=False,
            )
            self.backend = "llama-cpp"
        except Exception:
            self._model = None

    def answer(self, question: str, context_chunks: list[str]) -> str:
        context = "\n\n".join(context_chunks[:5]).strip()
        if not context:
            return "No indexed Wikipedia context is available yet. Download and index at least one article first."

        if self._model is None:
            return (
                "Local LLM is not loaded yet. Using retrieval-only fallback.\n\n"
                f"Question: {question}\n\n"
                "Top context:\n"
                f"{context[:1200]}"
            )

        system_prompt = (
            "You answer questions using only the provided context. "
            "If the answer is not in context, say you do not know."
        )
        user_prompt = (
            f"Question:\n{question}\n\n"
            f"Context:\n{context}\n\n"
            "Answer concisely and cite the context wording when possible."
        )
        try:
            response = self._model.create_chat_completion(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.2,
                max_tokens=300,
            )
            choices = response.get("choices", [])
            if choices:
                return choices[0]["message"]["content"].strip()
        except Exception:
            pass

        return (
            "The model failed to generate a response; showing retrieval context instead.\n\n"
            f"{context[:1200]}"
        )

