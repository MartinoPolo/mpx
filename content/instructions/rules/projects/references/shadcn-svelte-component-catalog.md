---
scope: reference
selector: shadcn-svelte
---

# shadcn-svelte Component Catalog

Reference lookup — not auto-loaded. Consult when choosing which component to reach for; linked from
the `shadcn-svelte.md` rule.

## Prefer Built-in Components

| Instead of           | Use                                                |
| -------------------- | -------------------------------------------------- |
| `<hr>` or border div | `<Separator />`                                    |
| `animate-pulse` div  | `<Skeleton class="h-4 w-3/4" />`                   |
| Custom styled span   | `<Badge variant="secondary">`                      |
| Custom callout div   | `<Alert>` with `Alert.Title` / `Alert.Description` |
| Custom empty state   | `<Empty.Root>` with sub-components                 |
| Custom toast         | `toast()` from `svelte-sonner`                     |

## Component Selection

#### Need: Button/action

- **Use:** `Button` with variant

#### Need: Form inputs

- **Use:** `Input` , `Select` , `Combobox` , `Switch` , `Checkbox` , `RadioGroup` , `Textarea` ,
  `InputOTP` , `Slider`

#### Need: Toggle 2–5 options

- **Use:** `ToggleGroup.Root` + `ToggleGroup.Item`

#### Need: Data display

- **Use:** `Table` , `Card` , `Badge` , `Avatar`

#### Need: Navigation

- **Use:** `Sidebar` , `Tabs` , `Breadcrumb` , `Pagination`

#### Need: Overlays

- **Use:** `Dialog` (modal), `Sheet` (side), `Drawer` (bottom), `AlertDialog` (confirm)

#### Need: Feedback

- **Use:** `svelte-sonner` (toast), `Alert` , `Progress` , `Skeleton` , `Spinner`

#### Need: Command palette

- **Use:** `Command` inside `Dialog`

#### Need: Layout

- **Use:** `Card` , `Separator` , `Resizable` , `ScrollArea` , `Accordion` , `Collapsible`

#### Need: Empty states

- **Use:** `Empty`

#### Need: Menus

- **Use:** `DropdownMenu` , `ContextMenu` , `Menubar`

#### Need: Tooltips/info

- **Use:** `Tooltip` , `HoverCard` , `Popover`
