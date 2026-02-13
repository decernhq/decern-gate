# Documentazione decern-gate

## Diagrammi UML

Il file **`uml.puml`** contiene i diagrammi UML dell’applicazione in formato [PlantUML](https://plantuml.com/). Sono definiti 5 diagrammi:

| Diagramma | Nome in PlantUML | Descrizione |
|-----------|------------------|-------------|
| **Componenti (overview)** | `decern-gate-overview` | Package principali (bin, main, judge-diff, required-patterns) e dipendenze da runtime (env, git, Decern API). |
| **Sequenza** | `decern-gate-sequence` | Flusso principale: da `run()` a getChangedFiles → policy → extractDecisionIds → validate → (opzionale) judge → exit code. |
| **Classi / Moduli** | `decern-gate-classes` | Moduli con operazioni pubbliche/private e tipi (ValidateResult, JudgeResult, JudgeDiffResult, PolicyResult). |
| **Attività** | `decern-gate-activity` | Diagramma di attività con tutte le decisioni della gate (blocco vs pass). |
| **Componenti (dettaglio)** | `decern-gate-components` | Componenti con sotto-unità e interfacce verso Env e Decern API. |

### Come visualizzare

- **VS Code / Cursor:** estensione “PlantUML” (es. `jebbs.plantuml`); apri `uml.puml` e usa “Preview Current Diagram” o esporta in PNG/SVG.
- **CLI:** con [PlantUML jar](https://plantuml.com/download) o `npm install -g node-plantuml` puoi generare le immagini da `uml.puml`.
- **Online:** copia il contenuto di un singolo blocco `@startuml` … `@enduml` su [plantuml.com/plantuml](https://www.plantuml.com/plantuml/uml).

Ogni blocco `@startuml nome` … `@enduml` è un diagramma separato; in molti viewer puoi scegliere quale renderizzare.
