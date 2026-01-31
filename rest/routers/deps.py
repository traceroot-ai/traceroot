"""FastAPI dependencies for authentication and database access."""

from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from db.postgres.engine import get_session as get_postgres_session


async def get_db_session():
    """Get a database session."""
    async with get_postgres_session() as session:
        yield session


DbSession = Annotated[AsyncSession, Depends(get_db_session)]
