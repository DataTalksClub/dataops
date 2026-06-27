import argparse
from pathlib import Path

from lambda_functions.docs_index import build_index


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a minsearch index.")
    parser.add_argument("--docs-dir", default="../content", type=Path)
    parser.add_argument(
        "--output",
        default="src/lambda_functions/search.index",
        type=Path,
        help="Output path for the generated index.",
    )
    args = parser.parse_args()

    count = build_index(args.docs_dir, args.output)
    print(f"Indexed {count} documents into {args.output}")


if __name__ == "__main__":
    main()
