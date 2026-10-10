import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { ChatSummary } from '@shared/schemas/chat'
import { api } from '../../lib/api'

export function ChatSidebar(props: {
  chats: ChatSummary[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onChanged: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')

  const commitRename = async (id: string) => {
    if (title.trim()) await api.invoke('chats:rename', { chatId: id, title })
    setEditing(null)
    props.onChanged()
  }

  const remove = async (chat: ChatSummary) => {
    if (!window.confirm(`Chat „${chat.title}“ löschen?`)) return
    await api.invoke('chats:delete', { chatId: chat.id })
    if (chat.id === props.activeId) props.onNew()
    props.onChanged()
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
      <div className="p-2">
        <button
          type="button"
          onClick={props.onNew}
          className="flex w-full items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <Plus size={16} /> Neuer Chat
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto px-2 pb-2 text-sm">
        {props.chats.map((chat) => (
          <li key={chat.id} className="group">
            {editing === chat.id ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void commitRename(chat.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(chat.id)
                  if (e.key === 'Escape') setEditing(null)
                }}
                className="w-full rounded-md border border-blue-500 bg-transparent px-2 py-1.5"
              />
            ) : (
              <div
                className={`flex items-center rounded-md ${
                  chat.id === props.activeId
                    ? 'bg-zinc-200 dark:bg-zinc-800'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
                }`}
              >
                <button
                  type="button"
                  onClick={() => props.onSelect(chat.id)}
                  className="min-w-0 flex-1 truncate px-2 py-1.5 text-left"
                  title={chat.title}
                >
                  {chat.title}
                </button>
                <button
                  type="button"
                  title="Umbenennen"
                  onClick={() => {
                    setEditing(chat.id)
                    setTitle(chat.title)
                  }}
                  className="hidden p-1 text-zinc-500 group-hover:block"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  title="Löschen"
                  onClick={() => void remove(chat)}
                  className="hidden p-1 text-zinc-500 group-hover:block hover:text-red-600"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  )
}
