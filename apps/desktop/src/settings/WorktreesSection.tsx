import { useEffect, useState } from "react";
import { api } from "@/api";
import type { Project } from "@/api/schema";
import { displayName } from "@/advanced/appearance-model";
import { ErrorNote } from "@/components/ui";
import {
  field,
  quiet,
  SettingRow,
  SettingsGroup,
} from "@/settings/settings-ui";
import {
  examplePath,
  overrideCount,
  parseWorktreeLocation,
  withOverride,
  withoutOverride,
  type Placement,
  type WorktreeLayout,
  type WorktreeLocation,
  type WorktreeMode,
} from "@/settings/worktrees-model";

const modes: { value: WorktreeMode; title: string; detail: string }[] = [
  {
    value: "megabrain",
    title: "In megabrain",
    detail: "One folder under ~/.megabrain/worktrees, grouped by project.",
  },
  {
    value: "repo",
    title: "Inside each project",
    detail:
      "A .worktrees folder in the repository, kept out of Git through .git/info/exclude.",
  },
  {
    value: "custom",
    title: "A folder you choose",
    detail:
      "Any folder, flat or grouped by project. Without one, the shared folder used until now.",
  },
];

const baseName = (path: string) =>
  path
    .split("/")
    .filter((part) => part !== "")
    .at(-1) ?? path;

/**
 * Where new worktrees go. Every change saves at once and only affects worktrees created afterwards;
 * existing ones stay where they are.
 */
export function WorktreesSection({
  projects,
  onOpenProject,
}: {
  projects: Project[];
  onOpenProject: (path: string) => void;
}) {
  const [saved, setSaved] = useState<WorktreeLocation | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.worktreeLocation().then(
      (raw) => setSaved(parseWorktreeLocation(raw)),
      (caught: unknown) => setError(caught),
    );
  }, []);

  if (saved === null)
    return error === null ? null : <ErrorNote error={error} />;

  const save = (next: WorktreeLocation) => {
    setSaved(next);
    api.setWorktreeLocation(JSON.stringify(next)).then(
      () => setError(null),
      (caught: unknown) => setError(caught),
    );
  };
  const chooseFolder = async (apply: (root: string) => void) => {
    const folder = await api.pickFolder();
    if (folder !== null) apply(folder);
  };

  const sample = projects[0] ?? null;
  const preview = (placement: Placement) =>
    sample === null
      ? null
      : examplePath(placement, {
          path: sample.path,
          name: baseName(sample.path),
        });
  // The layout only matters to a custom folder, so it is kept for when the person comes back to one.
  const withMode = (placement: Placement, mode: WorktreeMode): Placement => ({
    ...placement,
    mode,
  });
  const overridden = projects.filter(
    (project) => saved.projects[project.path] !== undefined,
  );
  const free = projects.filter(
    (project) => saved.projects[project.path] === undefined,
  );

  return (
    <>
      <p className="px-1 text-[13px] text-ink-400">
        New worktrees are created in the place you pick here. Worktrees that
        already exist stay where they are.
      </p>
      <SettingsGroup title="For every project">
        <div
          role="radiogroup"
          aria-label="Where worktrees live"
          className="grid gap-2 p-3 sm:grid-cols-3"
        >
          {modes.map((option) => {
            const selected = saved.mode === option.value;
            const next = withMode(saved, option.value);
            const example = preview(next);
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => save({ ...saved, ...next })}
                className={`grid content-start gap-1 rounded-[12px] border p-3 text-left transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none ${selected ? "border-accent/60 bg-white/[0.07]" : "border-white/[0.08] hover:border-white/[0.16]"}`}
              >
                <span className="text-[13.5px] font-medium text-ink-100">
                  {option.title}
                </span>
                <span className="text-[12.5px] text-ink-400">
                  {option.detail}
                </span>
                {example !== null && (
                  <code className="mt-1 break-all text-[11.5px] text-ink-300">
                    {example}
                  </code>
                )}
              </button>
            );
          })}
        </div>
        {saved.mode === "custom" && (
          <>
            <SettingRow
              label="Folder"
              description={
                saved.customRoot ??
                "The shared worktrees folder used until now."
              }
            >
              <button
                type="button"
                className={quiet}
                onClick={() =>
                  void chooseFolder((customRoot) =>
                    save({ ...saved, customRoot }),
                  )
                }
              >
                Choose…
              </button>
              {saved.customRoot !== null && (
                <button
                  type="button"
                  className={quiet}
                  onClick={() => save({ ...saved, customRoot: null })}
                >
                  Use the shared folder
                </button>
              )}
            </SettingRow>
            <SettingRow
              label="Layout"
              htmlFor="worktrees-layout"
              description="Grouped by project, or every worktree side by side in one folder."
            >
              <select
                id="worktrees-layout"
                className={field}
                value={saved.layout}
                onChange={(event) =>
                  save({
                    ...saved,
                    layout: event.target.value as WorktreeLayout,
                  })
                }
              >
                <option value="flat">All together</option>
                <option value="nested">By project</option>
              </select>
            </SettingRow>
          </>
        )}
      </SettingsGroup>
      <SettingsGroup
        title={`Projects with their own choice (${overrideCount(saved)})`}
        aside={
          free.length > 0 ? (
            <select
              aria-label="Give a project its own choice"
              className={field}
              value=""
              onChange={(event) => {
                if (event.target.value !== "")
                  save(
                    withOverride(saved, event.target.value, {
                      mode: saved.mode,
                      customRoot: saved.customRoot,
                      layout: saved.layout,
                    }),
                  );
              }}
            >
              <option value="">Add a project…</option>
              {free.map((project) => (
                <option key={project.path} value={project.path}>
                  {displayName(project)}
                </option>
              ))}
            </select>
          ) : undefined
        }
      >
        {overridden.length === 0 ? (
          <SettingRow
            label="None"
            description="Every project follows the choice above."
          />
        ) : (
          overridden.map((project) => {
            const placement = saved.projects[project.path] as Placement;
            return (
              <SettingRow
                key={project.path}
                label={
                  <button
                    type="button"
                    className="font-medium text-ink-100 underline-offset-2 hover:underline"
                    onClick={() => onOpenProject(project.path)}
                  >
                    {displayName(project)}
                  </button>
                }
                description={
                  placement.mode === "custom" &&
                  placement.customRoot === null ? (
                    "The shared worktrees folder."
                  ) : (
                    <code className="break-all text-[11.5px]">
                      {examplePath(placement, {
                        path: project.path,
                        name: baseName(project.path),
                      })}
                    </code>
                  )
                }
              >
                <select
                  aria-label={`Where ${displayName(project)} keeps its worktrees`}
                  className={field}
                  value={placement.mode}
                  onChange={(event) =>
                    save(
                      withOverride(
                        saved,
                        project.path,
                        withMode(placement, event.target.value as WorktreeMode),
                      ),
                    )
                  }
                >
                  {modes.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.title}
                    </option>
                  ))}
                </select>
                {placement.mode === "custom" && (
                  <button
                    type="button"
                    className={quiet}
                    onClick={() =>
                      void chooseFolder((customRoot) =>
                        save(
                          withOverride(saved, project.path, {
                            ...placement,
                            customRoot,
                          }),
                        ),
                      )
                    }
                  >
                    Choose…
                  </button>
                )}
                <button
                  type="button"
                  className={quiet}
                  onClick={() => save(withoutOverride(saved, project.path))}
                >
                  Use the default
                </button>
              </SettingRow>
            );
          })
        )}
      </SettingsGroup>
      {error !== null && <ErrorNote error={error} />}
    </>
  );
}
