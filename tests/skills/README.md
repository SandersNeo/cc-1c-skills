# Регресс-тесты навыков

Snapshot-тестирование скриптов навыков: навык получает вход → генерирует файлы → результат сравнивается с эталоном.

Быстрые, файловые, без зависимости от платформы 1С.

## Запуск

```bash
node tests/skills/runner.mjs                                    # все кейсы
node tests/skills/runner.mjs cases/meta-compile                 # один навык
node tests/skills/runner.mjs cases/meta-compile/catalog-basic   # один кейс
node tests/skills/runner.mjs --update-snapshots                 # обновить эталоны
node tests/skills/runner.mjs --runtime python                   # запуск на PY-версиях
node tests/skills/runner.mjs --json report.json                 # JSON-отчёт
```

Exit code: 0 = все прошли, 1 = есть падения.

## Как добавить навык

1. Создать папку `tests/skills/cases/<имя-навыка>/`
2. Положить `_skill.json` — описание навыка для раннера
3. Добавить кейсы — по одному `.json` файлу на кейс

### Формат _skill.json

```json
{
  "script": "meta-compile/scripts/meta-compile",
  "setup": "empty-config",
  "args": [
    { "flag": "-JsonPath", "from": "inputFile" },
    { "flag": "-OutputDir", "from": "workDir" }
  ],
  "snapshot": {
    "root": "workDir",
    "normalizeUuids": true
  }
}
```

| Поле | Описание |
|---|---|
| `script` | Путь от `.claude/skills/`, без расширения. Раннер добавит `.ps1` или `.py` |
| `setup` | Фикстура: `"empty-config"` (пустая конфа), `"base-config"`, `"none"`, `"fixture:<name>"` |
| `args` | Маппинг параметров навыка (см. ниже) |
| `snapshot` | Настройки сравнения: `root` и `normalizeUuids` |

### Значения `from` в args

| Значение | Что подставляется |
|---|---|
| `"inputFile"` | Путь к temp-файлу с `case.input` (JSON) |
| `"workDir"` | Рабочая директория (копия фикстуры) |
| `"outputPath"` | `workDir` + `case.outputPath` |
| `"case.<field>"` | Поле из JSON кейса, напр. `case.name`, `case.objectPath` |
| `"switch"` | Флаг без значения (напр. `-Detailed`) |
| `"literal"` | Фиксированное значение из `mapping.value` |

## Как добавить кейс

Положить `.json` файл в папку навыка. Имя файла = имя кейса.

### Позитивный кейс (минимальный)

```json
{
  "name": "Простой справочник",
  "input": { "type": "Catalog", "name": "Валюты" }
}
```

Раннер проверит: exitCode=0 + выход совпадает со snapshot (если есть).

### С дополнительными проверками

```json
{
  "name": "Справочник с ТЧ",
  "input": { "type": "Catalog", "name": "Товары", "tabularSections": [...] },
  "expect": {
    "files": ["Catalogs/Товары.xml"],
    "stdoutContains": "compiled"
  }
}
```

### Негативный кейс

```json
{
  "name": "Ошибка: пустое имя",
  "input": { "type": "Catalog", "name": "" },
  "expectError": true
}
```

`expectError: true` — ожидается exitCode≠0. Можно указать строку — проверит наличие в stderr.

### Поля кейса

| Поле | Обязательно | Описание |
|---|---|---|
| `name` | да | Название теста (отображается в отчёте) |
| `input` | нет | JSON-объект, передаётся навыку через temp-файл |
| `setup` | нет | Переопределение setup из `_skill.json` |
| `outputPath` | нет | Относительный путь для `-OutputPath` навыков |
| `expect` | нет | Дополнительные проверки: `files`, `stdoutContains` |
| `expectError` | нет | `true` или строка — ожидается ошибка |

## Эталоны (snapshots)

Эталон — директория `<имя-кейса>.snapshot/` рядом с `.json` файлом кейса. Содержит ожидаемый выход навыка после нормализации.

### Создание / обновление эталонов

```bash
node tests/skills/runner.mjs --update-snapshots                 # все кейсы
node tests/skills/runner.mjs cases/meta-compile --update-snapshots  # один навык
```

### Когда обновлять

- После изменения логики навыка (новый выход — новый эталон)
- После сертификации: загрузить результат в 1С (`db-load-xml`), убедиться что платформа приняла, затем `--update-snapshots`

### Нормализация

Перед сравнением (и при сохранении) применяется:
- **UUID** → `UUID-001`, `UUID-002`... (по порядку появления, ссылочная целостность сохраняется)
- **BOM** (U+FEFF) — удаляется
- **Line endings** — `\r\n` → `\n`

## Структура

```
tests/skills/
  runner.mjs              # тест-раннер
  README.md               # этот файл
  .cache/                 # кэш фикстур (в .gitignore)
  fixtures/               # broken-фикстуры для тестов валидаторов
  cases/
    <навык>/
      _skill.json         # конфиг навыка
      <кейс>.json         # тестовый случай
      <кейс>.snapshot/    # эталон
```
