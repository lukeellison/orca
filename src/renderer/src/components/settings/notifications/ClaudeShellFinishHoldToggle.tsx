import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { getLocalExecutionHostLabel } from '../../../../../shared/execution-host'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { NotificationSettingToggle } from './NotificationSettingToggle'

/** `unsupported`: an older host that neither reports nor accepts the setting. */
type HostSetting =
  | { state: 'loading' }
  | { state: 'unsupported' }
  | { state: 'ready'; enabled: boolean }

type HostSettings = { settings: Partial<GlobalSettings> }

function readHostSetting(settings: Partial<GlobalSettings>): HostSetting {
  // Newer hosts always report the key; its absence means the host would reject an update.
  return typeof settings.claudeFinishedWaitsForBackgroundShells === 'boolean'
    ? { state: 'ready', enabled: settings.claudeFinishedWaitsForBackgroundShells }
    : { state: 'unsupported' }
}

/** The host that runs Claude's hooks decides when "finished" fires, so the switch reads and writes that host. */
export function ClaudeShellFinishHoldToggle({
  settings,
  updateSettings,
  hostScope,
  disabled
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  hostScope: SettingsHostScope
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const hostName = useAppStateValue((state) =>
    environmentId
      ? state.runtimeEnvironments.find((entry) => entry.id === environmentId)?.name
      : null
  )
  const hostLabel = hostName ?? getLocalExecutionHostLabel()
  const [remote, setRemote] = useState<{ environmentId: string; setting: HostSetting } | null>(null)

  useEffect(() => {
    if (!environmentId) {
      return
    }
    let current = true
    void callRuntimeRpc<HostSettings>(
      { kind: 'environment', environmentId },
      'settings.get',
      undefined,
      { timeoutMs: 15_000 }
    ).then(
      (result) => {
        if (current) {
          setRemote({ environmentId, setting: readHostSetting(result.settings) })
        }
      },
      (error: unknown) => console.error('Failed to load the host background shell setting:', error)
    )
    return () => {
      current = false
    }
  }, [environmentId])

  const setting: HostSetting = !environmentId
    ? { state: 'ready', enabled: settings.claudeFinishedWaitsForBackgroundShells === true }
    : remote?.environmentId === environmentId
      ? remote.setting
      : { state: 'loading' }
  const enabled = setting.state === 'ready' && setting.enabled
  const update = async (next: boolean): Promise<void> => {
    if (!environmentId) {
      await updateSettings({ claudeFinishedWaitsForBackgroundShells: next })
      return
    }
    try {
      const result = await callRuntimeRpc<HostSettings>(
        { kind: 'environment', environmentId },
        'settings.update',
        { claudeFinishedWaitsForBackgroundShells: next },
        { timeoutMs: 15_000 }
      )
      setRemote({ environmentId, setting: readHostSetting(result.settings) })
    } catch (error) {
      toast.error(
        t(
          'settings.notifications.claudeShellFinishHold.updateFailed',
          'Could not update the setting on {{host}}.',
          { host: hostLabel }
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    }
  }
  return (
    <div className="ml-6">
      <NotificationSettingToggle
        label={t(
          'settings.notifications.claudeShellFinishHold.title',
          'Wait for background shells'
        )}
        description={
          setting.state === 'unsupported'
            ? t(
                'settings.notifications.claudeShellFinishHold.unsupported',
                'Update Orca on {{host}} to change this setting there.',
                { host: hostLabel }
              )
            : t(
                'settings.notifications.claudeShellFinishHold.description',
                'Claude’s finished alert waits up to 30 minutes for background shells it started to exit.'
              )
        }
        checked={enabled}
        disabled={disabled || setting.state !== 'ready' || !hostScope.available}
        onToggle={() => void update(!enabled)}
      />
    </div>
  )
}
