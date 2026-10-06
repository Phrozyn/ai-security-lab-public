from pathlib import Path

import click

CORPUS_DIR = Path(__file__).resolve().parent.parent.parent / "corpus"


@click.group()
def main():
    """RAG app: retrieval-time ACL enforcement, redaction, guardrail scanning."""


@main.command()
def ingest():
    """Embed and store the test corpus."""
    from ragapp.ingest import ingest_corpus

    count = ingest_corpus(CORPUS_DIR)
    click.echo(f"Ingested {count} documents.")


@main.command()
@click.option("--user", "username", required=True, help="Simulated user (see corpus/users.yaml)")
@click.option("--question", required=True)
def query(username: str, question: str):
    """Ask a question as a given simulated user."""
    from ragapp.query import query as run_query

    result = run_query(CORPUS_DIR, username, question)

    click.echo(f"retrieved_doc_ids: {result.retrieved_doc_ids}")
    click.echo(f"redacted_entity_types: {result.redacted_entity_types}")
    click.echo(f"input_blocked: {result.input_blocked} ({result.input_verdict!r})")
    click.echo(f"output_blocked: {result.output_blocked} ({result.output_verdict!r})")
    click.echo("---")
    click.echo(result.answer)


if __name__ == "__main__":
    main()
