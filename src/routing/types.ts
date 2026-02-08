// Routing types for channel-agent bindings

export type ChannelId = 'websocket' | 'telegram' | 'discord' | 'slack' | 'whatsapp'

export type PeerKind = 'dm' | 'group' | 'channel'

export interface RoutePeer {
  kind: PeerKind
  id: string
}

export interface BindingMatch {
  channel: ChannelId
  accountId?: string      // 账户 ID（多账户支持）
  peer?: RoutePeer        // 特定用户/群组
  guildId?: string        // Discord 服务器
  teamId?: string         // Slack 工作区
}

export interface Binding {
  id: string
  agentId: string
  match: BindingMatch
  priority?: number       // 优先级（数字越小优先级越高）
  createdAt: number
  updatedAt: number
}

export interface BindingStore {
  bindings: Binding[]
}

// 路由输入
export interface RouteInput {
  channel: ChannelId
  accountId?: string
  peer?: RoutePeer
  guildId?: string
  teamId?: string
}

// 路由结果
export interface RouteResult {
  agentId: string
  matchedBy: 'peer' | 'guild' | 'team' | 'account' | 'channel' | 'default'
  binding?: Binding
}
