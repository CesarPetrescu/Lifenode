from pydantic import BaseModel, Field


class WikiDownloadRequest(BaseModel):
    title: str = Field(min_length=1, max_length=300)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    top_k: int = Field(default=4, ge=1, le=20)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=600)
    top_k: int = Field(default=4, ge=1, le=20)


class NoteUpdateRequest(BaseModel):
    content: str = Field(default="", max_length=20000)


class CalendarEventCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    start_ts: str = Field(min_length=1, max_length=40)
    end_ts: str = Field(min_length=1, max_length=40)
    details: str = Field(default="", max_length=4000)

