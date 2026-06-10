import { useCallback, useMemo, useState } from 'react'
import {
  DataEditor,
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme
} from '@glideapps/glide-data-grid'
import type { CellValue, ColumnMeta } from '@shared/types'
import { useElementSize } from '@/hooks/useElementSize'
import { cellToText } from '@/utils'

export type RowKind = 'normal' | 'new' | 'deleted'

interface DataGridViewProps {
  columns: ColumnMeta[]
  rowCount: number
  getCellValue: (row: number, col: number) => CellValue
  editable?: boolean
  onCellEdited?: (row: number, col: number, value: CellValue) => void
  isCellEdited?: (row: number, col: number) => boolean
  getRowKind?: (row: number) => RowKind
  onHeaderClicked?: (col: number) => void
  /** 列标题后缀（排序箭头） */
  headerSuffix?: (colName: string) => string
  onSelectedRowsChange?: (rows: number[]) => void
  dark: boolean
}

function gridTheme(dark: boolean): Partial<Theme> {
  return dark
    ? {
        bgCell: '#1e1f22',
        bgHeader: '#26282b',
        bgHeaderHovered: '#2f3236',
        bgHeaderHasFocus: '#2f3236',
        textDark: '#d4d6d9',
        textHeader: '#b8bcc2',
        borderColor: '#36383c',
        accentColor: '#1e90ce',
        accentLight: '#1e90ce22',
        bgSearchResult: '#6b5d00'
      }
    : {
        bgCell: '#ffffff',
        bgHeader: '#f5f6f7',
        bgHeaderHovered: '#ebedef',
        bgHeaderHasFocus: '#ebedef',
        textDark: '#26282b',
        textHeader: '#4a4d52',
        borderColor: '#e2e4e8',
        accentColor: '#0a87c4',
        accentLight: '#0a87c41a'
      }
}

export function DataGridView({
  columns,
  rowCount,
  getCellValue,
  editable = false,
  onCellEdited,
  isCellEdited,
  getRowKind,
  onHeaderClicked,
  headerSuffix,
  onSelectedRowsChange,
  dark
}: DataGridViewProps): React.JSX.Element {
  const { ref, width, height } = useElementSize<HTMLDivElement>()
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<GridSelection>()

  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columns.map((c) => ({
        id: c.name,
        title: `${c.name}${headerSuffix ? headerSuffix(c.name) : ''}`,
        width: colWidths[c.name] ?? Math.min(Math.max(c.name.length * 10 + 50, 90), 280)
      })),
    [columns, colWidths, headerSuffix]
  )

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const value = getCellValue(row, col)
      const edited = isCellEdited?.(row, col) ?? false
      const rowKind = getRowKind?.(row) ?? 'normal'
      const themeOverride: Partial<Theme> | undefined =
        rowKind === 'deleted'
          ? { bgCell: dark ? '#4a2326' : '#ffe3e3', textDark: dark ? '#8c8c8c' : '#a8a8a8' }
          : rowKind === 'new'
            ? { bgCell: dark ? '#1f3a26' : '#e5f7e8' }
            : edited
              ? { bgCell: dark ? '#4a3d12' : '#fff5d6' }
              : undefined
      const allowOverlay = editable && rowKind !== 'deleted'

      if (value === null) {
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '(NULL)',
          allowOverlay,
          themeOverride: { ...themeOverride, textDark: dark ? '#6a6d72' : '#b0b3b8' }
        }
      }
      if (typeof value === 'object' && '__type' in value) {
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: cellToText(value),
          allowOverlay: false,
          themeOverride
        }
      }
      if (typeof value === 'number') {
        return {
          kind: GridCellKind.Number,
          data: value,
          displayData: String(value),
          allowOverlay,
          themeOverride
        }
      }
      if (typeof value === 'boolean') {
        return {
          kind: GridCellKind.Boolean,
          data: value,
          allowOverlay: false,
          readonly: !editable,
          themeOverride
        }
      }
      return {
        kind: GridCellKind.Text,
        data: value,
        displayData: value,
        allowOverlay,
        themeOverride
      }
    },
    [getCellValue, isCellEdited, getRowKind, editable, dark]
  )

  const handleCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      if (!onCellEdited) return
      if (newValue.kind === GridCellKind.Text) {
        onCellEdited(row, col, newValue.data)
      } else if (newValue.kind === GridCellKind.Number) {
        onCellEdited(row, col, newValue.data ?? null)
      } else if (newValue.kind === GridCellKind.Boolean) {
        onCellEdited(row, col, newValue.data ?? null)
      }
    },
    [onCellEdited]
  )

  const handleSelection = useCallback(
    (sel: GridSelection) => {
      setSelection(sel)
      onSelectedRowsChange?.(sel.rows.toArray())
    },
    [onSelectedRowsChange]
  )

  const theme = useMemo(() => gridTheme(dark), [dark])

  return (
    <div ref={ref} className="data-grid-host">
      {width > 0 && height > 0 && (
        <DataEditor
          width={width}
          height={height}
          columns={gridColumns}
          rows={rowCount}
          getCellContent={getCellContent}
          onCellEdited={editable ? handleCellEdited : undefined}
          onColumnResize={(col, w) =>
            setColWidths((prev) => ({ ...prev, [col.id as string]: w }))
          }
          onHeaderClicked={onHeaderClicked ? (col) => onHeaderClicked(col) : undefined}
          gridSelection={selection}
          onGridSelectionChange={handleSelection}
          rowMarkers="both"
          smoothScrollX
          smoothScrollY
          getCellsForSelection
          theme={theme}
          minColumnWidth={60}
          maxColumnAutoWidth={400}
        />
      )}
    </div>
  )
}
