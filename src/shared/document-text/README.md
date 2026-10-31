# Document text extraction

This library owns bounded OOXML decoding from bytes. It has no filesystem grants,
plugin loader, Runtime service, source registry, settings or model-facing tools.
Resources uses the library directly; optional plugins consume the SDK facade.
There is no dependency between either consumer. The public plugin build bundles
its library code, so it does not load a core plugin at execution time.

Callers select the retained-character budget and own the meaning of truncation.
Resources rejects truncated documents before publishing an index; Document Reader
preserves its existing bounded-window result and coverage metadata. Archive entry
and expanded XML limits are format safety ceilings shared by all consumers.

DOCX parts undergo a lightweight structural check before text is returned to
either consumer: one root, balanced tags and complete markup. This rejects
truncated document, header, footer or note XML with `document_xml_invalid`;
Resources maps it to `basket_docx_xml_invalid` and never indexes a surviving
prefix. The check uses the existing expanded-entry and total-XML byte limits.
It is not full XML or OOXML schema validation and does not support DTDs.
