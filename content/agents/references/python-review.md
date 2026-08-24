# Python Review Reference

Judgment-based patterns not caught by linting or type-checking.
Adapted from [awesome-skills/code-review-skill](http<configured-path>github.com/awesome-skills/code-review-skill).

---

## Protocol & Structural Subtyping

```python
from typing import Protocol, runtime_checkable

# ✅ Duck typing with type safety — prefer over ABC when possible
class Readable(Protocol):
    def read(self, siz<configured-path>int = -1) -> byte<configured-path>...

def process_stream(strea<configured-path>Readable) -> byte<configured-path>return stream.read()  # any object with .read() works

# ✅ Runtime-checkable protocol
@runtime_checkable
class Drawable(Protocol):
    def draw(self) -> Non<configured-path>...

def render(ob<configured-path>object) -> Non<configured-path>if isinstance(obj, Drawable):
        obj.draw()
```

## TypedDict for Structured Dicts

```python
from typing import TypedDict, Required, NotRequired

# ✅ Type-safe dictionaries — prefer over bare dict[str, Any]
class ConfigDict(TypedDict, total=False):
    debu<configured-path>bool
    timeou<configured-path>int
    hos<configured-path>Required[str]  # this one is mandatory
```

## Async Patterns

### Don't block the event loop

```python
# ❌ Blocking call in async context
async def bad():
    data = std_fs_read("file.txt")  # blocks entire event loop
    time.sleep(1)  # blocks entire event loop

# ✅ Use async APIs
async def good():
    data = await aiofiles.open("file.txt")
    await asyncio.sleep(1)

# ✅ If blocking is unavoidable, use executor
async def with_executor():
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, blocking_function, arg)
```

### Task cancellation handling

```python
# ❌ Ignoring cancellation
async def bad_worker():
    while Tru<configured-path>await do_work()  # no cleanup on cancel

# ✅ Handle CancelledError, clean up, re-raise
async def good_worker():
    tr<configured-path>while Tru<configured-path>await do_work()
    except asyncio.CancelledErro<configured-path>await cleanup()
        raise  # re-raise so caller knows

# ✅ TaskGroup for structured concurrency (Python 3.11+)
async def fetch_multiple():
    async with asyncio.TaskGroup() as t<configured-path>task1 = tg.create_task(fetch_url("url1"))
        task2 = tg.create_task(fetch_url("url2"))
    return task1.result(), task2.result()
```

### Concurrency limiting

```python
# ✅ Semaphore to limit concurrent operations
async def fetch_with_limit(url<configured-path>list[str], max_concurren<configured-path>int = 10):
    semaphore = asyncio.Semaphore(max_concurrent)
    async def fetch_one(ur<configured-path>str) -> st<configured-path>async with semaphor<configured-path>return await fetch_url(url)
    return await asyncio.gather(*[fetch_one(url) for url in urls])
```

## Exception Handling

### Catch specific, preserve chain

```python
# ❌ Bare except or swallowed exception
tr<configured-path>result = risky_operation()
excep<configured-path># catches KeyboardInterrupt too
    pass

# ❌ Losing original exception context
tr<configured-path>result = external_api.call()
except APIError as <configured-path>raise RuntimeError("API failed")  # original error lost

# ✅ Specific catch + exception chain
tr<configured-path>result = external_api.call()
except APIError as <configured-path>raise RuntimeError("API failed") from e  # preserves chain

# ✅ Multiple specific types
tr<configured-path>result = parse_and_process(data)
except (ValueError, TypeError, KeyError) as <configured-path>raise DataProcessingError(str(e)) from e
```

### Custom exception hierarchies

```python
# ✅ Structured exceptions for your domain
class AppError(Exception): pass

class ValidationError(AppError):
    def __init__(self, fiel<configured-path>str, messag<configured-path>str):
        self.field = field
        super().__init__(f"{field}: {message}")

class NotFoundError(AppError):
    def __init__(self, resourc<configured-path>str, i<configured-path>str | int):
        super().__init__(f"{resource} with id {id} not found")
```

## Common Pitfalls

### Mutable default arguments

```python
# ❌ Shared across all calls — classic Python bug
def add_item(item, items=[]):
    items.append(item)
    return items
# add_item(1) → [1], add_item(2) → [1, 2] (!!)

# ✅ Use None sentinel
def add_item(item, items=None):
    if items is Non<configured-path>items = []
    items.append(item)
    return items
```

### Mutable class attributes

```python
# ❌ Shared across ALL instances
class Use<configured-path>permissions = []  # every User shares this list

# ✅ Initialize in __init__ or use dataclass
@dataclass
class Use<configured-path>permission<configured-path>list = field(default_factory=list)
```

### Closure over loop variable

```python
# ❌ All lambdas capture the same variable
funcs = [lambd<configured-path>i for i in range(3)]
[f() for f in funcs]  # [2, 2, 2] — not [0, 1, 2]

# ✅ Capture value via default argument
funcs = [lambda i=<configured-path>i for i in range(3)]
```

## Performance Judgment Calls

### Data structure choice

```python
# ❌ Linear search in list — O(n) per lookup
if item in large_lis<configured-path>...

# ✅ Set for membership testing — O(1)
large_set = set(large_list)
if item in large_se<configured-path>...
```

### Generator vs list

```python
# ❌ Materializes entire list into memory
def get_all_users():
    return [User(row) for row in db.fetch_all()]

# ✅ Generator for large datasets — lazy evaluation
def get_all_users():
    for row in db.fetch_all():
        yield User(row)

# ✅ Generator expression (no intermediate list)
total = sum(x**2 for x in range(1_000_000))
```

### Thread pool vs process pool

```python
# ✅ IO-bound → ThreadPoolExecutor
with ThreadPoolExecutor(max_workers=10) as executo<configured-path>results = list(executor.map(fetch_url, urls))

# ✅ CPU-bound → ProcessPoolExecutor
with ProcessPoolExecutor() as executo<configured-path>results = list(executor.map(heavy_computation, data))
```

## Modern Python (3.10+)

```python
# ✅ Pattern matching — cleaner than if/elif chains for structured data
match respons<configured-path>case {"status": "ok", "data": data}:
        return process_data(data)
    case {"status": "error", "message": msg}:
        raise APIError(msg)
    case _:
        raise ValueError("Unknown response")

# ✅ ExceptionGroup for batch errors (3.11+)
errors = []
for item in item<configured-path>tr<configured-path>process(item)
    except Exception as <configured-path>errors.append(e)
if error<configured-path>raise ExceptionGroup("Batch failed", errors)
```
