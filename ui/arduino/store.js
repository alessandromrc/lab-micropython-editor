const log = console.log
const DEFAULT_PANEL_HEIGHT = '25rem'

function resizeEditor(state) {
  const el = state.cache(AceEditor, 'editor').element
  if (state.isTerminalOpen || state.isFilesOpen) {
    el.style.height = `calc(100% - ${state.panelHeight || DEFAULT_PANEL_HEIGHT})`
  } else {
    el.style.height = '100%'
  }
}

function getSerialPath(state, filename) {
  return state.navigationPath + '/' + filename
}

function getDiskPath(state) {
  return state.diskPath + state.navigationPath + '/'
}

function store(state, emitter) {
  const serial = window.BridgeSerial
  const disk = window.BridgeDisk

  state.ports = []
  state.diskFiles = []
  state.serialFiles = []
  state.selectedFile = null
  state.selectedDevice = 'disk'

  state.diskPath = null
  state.serialPath = null
  state.navigationPath = '/'

  state.isConnected = false
  state.isPortDialogOpen = false
  state.isNewFileDialogOpen = false
  state.isTerminalOpen = false
  state.isFilesOpen = false
  state.isEditingFilename = false

  state.messageText = 'Disconnected'
  state.isShowingMessage = true
  state.messageTimeout = 0

  state.isTerminalBound = false // XXX
  state.panelHeight = null

  // SERIAL CONNECTION
  emitter.on('load-ports', async () => {
    log('load-ports')
    state.ports = await serial.loadPorts()
    emitter.emit('render')
  })
  emitter.on('open-port-dialog', async () => {
    log('open-port-dialog')
    emitter.emit('disconnect')
    state.ports = await serial.loadPorts()
    state.isPortDialogOpen = true
    emitter.emit('render')
  })
  emitter.on('close-port-dialog', async () => {
    log('close-port-dialog')
    state.isPortDialogOpen = false
    emitter.emit('render')
  })

  emitter.on('disconnect', () => {
    log('disconnect')
    if (state.isConnected) {
      emitter.emit('message', 'Disconnected')
    }
    state.isConnected = false
    state.serialPath = null
    state.isTerminalOpen = false
    state.serialFiles = []
    emitter.emit('render')
  })
  emitter.on('connect', async (path) => {
    log('connect')
    state.serialPath = path
    await serial.connect(path)
    emitter.emit('message', 'Connected', 150)
    await serial.stop()

    let term = state.cache(XTerm, 'terminal').term
    if (!state.isTerminalBound) {
      state.isTerminalBound = true
      term.onData((data) => {
        serial.eval(data)
        term.scrollToBottom()
      })
    }
    serial.onData((data) => {
      term.write(data)
      term.scrollToBottom()
    })
    serial.onDisconnect(() => emitter.emit('disconnect'))
    state.isConnected = true
    emitter.emit('update-files')
    emitter.emit('close-port-dialog')
    emitter.emit('show-terminal')
    emitter.emit('render')
  })

  // CODE EXECUTION
  emitter.on('run', async () => {
    log('run')
    if (!state.isTerminalOpen) emitter.emit('show-terminal')
    let editor = state.cache(AceEditor, 'editor').editor
    let code = editor.getValue()
    await serial.run(code)
    emitter.emit('render')
  })
  emitter.on('stop', async () => {
    log('stop')
    await serial.stop()
    emitter.emit('render')
  })
  emitter.on('reset', async () => {
    log('reset')
    await serial.reset()
    emitter.emit('update-files')
    emitter.emit('render')
  })

  // FILE MANAGEMENT
  emitter.on('open-new-file-dialog', () => {
    log('open-new-file-dialog')
    state.isNewFileDialogOpen = true
    emitter.emit('render')
  })
  emitter.on('close-new-file-dialog', () => {
    log('close-new-file-dialog')
    state.isNewFileDialogOpen = false
    emitter.emit('render')
  })
  emitter.on('new-file', (dev) => {
    log('select-device', dev)
    state.selectedDevice = dev
    let editor = state.cache(AceEditor, 'editor').editor
    state.selectedFile = 'undefined'
    editor.setValue('')
    emitter.emit('close-new-file-dialog')
    emitter.emit('render')
  })
  emitter.on('save', async () => {
    log('save')
    let editor = state.cache(AceEditor, 'editor').editor
    let contents = editor.getValue()
    let filename = state.selectedFile || 'undefined'

    if (state.selectedDevice === 'serial') {
      const path = getSerialPath(state, filename)
      await serial.saveFileContent(path, contents)
    }

    if (state.selectedDevice === 'disk' && state.diskPath) {
      const path = getDiskPath(state)
      await disk.saveFileContent(path, filename, contents)
    }

    emitter.emit('update-files')
  })
  emitter.on('remove', async () => {
    log('remove')
    if (state.selectedDevice === 'serial') {
      const path = getSerialPath(state, state.selectedFile)
      await serial.removeFile(path)
    }
    if (state.selectedDevice === 'disk') {
      const path = getDiskPath(state)
      await disk.removeFile(path, state.selectedFile)
    }
    emitter.emit('update-files')
  })
  emitter.on('select-file', async (device, filename) => {
    log('select-file')

    state.selectedDevice = device

    /*
    XXX: If user is changing a file name, do not request the file from the board
    over serial to prevent two commands being executed at the same time.
    TODO: Create a queue of actions and execute them in order
    */
    if (state.selectedDevice === 'serial' && state.isEditingFilename) return

    state.selectedFile = filename

    let content = ''
    if (state.selectedDevice === 'serial') {
      const path = getSerialPath(state, filename)
      content = await serial.loadFile(path)
      content = content.replace(//g, ``) // XXX: Remove character that breaks execution
    }

    if (state.selectedDevice === 'disk') {
      const path = getDiskPath(state)
      content = await disk.loadFile(path, filename)
    }

    let editor = state.cache(AceEditor, 'editor').editor
    editor.setValue(content)

    emitter.emit('render')
  })
  emitter.on('open-folder', async () => {
    log('open-folder')
    let { folder, files } = await disk.openFolder()
    state.diskPath = folder
    state.diskFiles = files
    if (!state.isFilesOpen) emitter.emit('show-files')
    emitter.emit('render')
  })
  emitter.on('update-files', async () => {
    log('update-files')
    if (state.isConnected) {
      await serial.stop()
      try {
        state.serialFiles = await serial.listFiles(state.navigationPath)
        state.serialFiles = state.serialFiles.filter(
          f => f.indexOf('.') !== -1 // Only files with extensions
        )
        state.serialFiles = state.serialFiles.filter(
          f => f.indexOf('.') !== 0 // No dot files
        )
      } catch (e) {
        console.log('error', e)
      }
    }
    if (state.diskPath) {
      try {
        state.diskFiles = await disk.listFiles(state.diskPath + state.navigationPath)
      } catch (e) {
        console.log('error', e)
      }
    }
    emitter.emit('render')
  })
  emitter.on('upload', async () => {
    log('upload')
    emitter.emit('message', 'Uploading file... Please wait')
    await serial.uploadFile(state.diskPath, state.selectedFile)
    emitter.emit('message', 'File uploaded!', 500)
    emitter.emit('update-files')
    emitter.emit('render')
  })
  emitter.on('download', async () => {
    log('download')
    emitter.emit('message', 'Downloading file... Please wait')
    await serial.downloadFile(state.diskPath, state.selectedFile)
    emitter.emit('message', 'File downloaded!', 500)
    emitter.emit('update-files')
    emitter.emit('render')
  })
  emitter.on('select-root-folder', () => {
    state.navigationPath = '/'
    emitter.emit('update-files')
  })
  emitter.on('select-lib-folder', () => {
    state.navigationPath = '/lib'
    emitter.emit('update-files')
  })

  // PANEL MANAGEMENT
  emitter.on('show-terminal', () => {
    log('show-terminal')
    if (state.panelHeight === null) state.panelHeight = DEFAULT_PANEL_HEIGHT
    state.isTerminalOpen = !state.isTerminalOpen
    state.isFilesOpen = false
    emitter.emit('render')
    resizeEditor(state)
  })
  emitter.on('show-files', () => {
    log('show-files')
    if (state.panelHeight === null) state.panelHeight = DEFAULT_PANEL_HEIGHT
    state.isTerminalOpen = false
    state.isFilesOpen = !state.isFilesOpen
    emitter.emit('update-files')
    emitter.emit('render')
    resizeEditor(state)
  })
  emitter.on('close-panel', () => {
    log('close-panel')
    state.isTerminalOpen = false
    state.isFilesOpen = false
    emitter.emit('render')
    resizeEditor(state)
  })
  emitter.on('start-resizing-panel', () => {
    log('start-resizing-panel')
    function handleMouseMove(e) {
      let height = window.innerHeight - e.clientY
      state.panelHeight = `${height}px`
      emitter.emit('render')
      resizeEditor(state)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', (e) => {
      window.removeEventListener('mousemove', handleMouseMove)
    }, { once: true })
  })

  emitter.on('clean-terminal', () => {
    state.cache(XTerm, 'terminal').term.clear()
  })

  // NAMING/RENAMING FILE
  emitter.on('edit-filename', () => {
    state.isEditingFilename = true
    emitter.emit('render')
  })
  emitter.on('save-filename', async (filename) => {
    log('save-filename', filename)
    let oldFilename = state.selectedFile
    state.selectedFile = filename

    let editor = state.cache(AceEditor, 'editor').editor
    let contents = editor.getValue()

    if (state.selectedDevice === 'serial') {
      if (state.serialFiles.indexOf(oldFilename) !== -1) {
        // If old name exists, rename file
        const oldPath = getSerialPath(state, oldFilename)
        const newPath = getSerialPath(state, filename)
        await serial.renameFile(oldPath, newPath)
      } else {
        // If old name doesn't exist create new file
        const path = getSerialPath(state, filename)
        await serial.saveFileContent(path, contents)
      }
    }

    if (state.diskPath !== null && state.selectedDevice === 'disk') {
      const path = getDiskPath(state)
      if (state.diskFiles.indexOf(oldFilename) !== -1) {
        // If old name exists, rename file
        await disk.renameFile(path, oldFilename, filename)
      } else {
        // If old name doesn't exist create new file
        await disk.saveFileContent(path, filename, contents)
      }
    }

    state.isEditingFilename = false
    emitter.emit('update-files')
    emitter.emit('render')

    emitter.emit('message', "Filename is saved.", 1000)
  })

  emitter.on('message', (text, timeout) => {
    log('message', text)
    state.messageText = text
    state.isShowingMessage = true
    if (timeout) {
      clearInterval(state.messageTimeout)
      state.messageTimeout = setTimeout(() => {
        state.isShowingMessage = false
        emitter.emit('render')
      }, timeout)
    }
    emitter.emit('render')
  })

  window.addEventListener('resize', () => {
    console.log('resize window')
    state.cache(AceEditor, 'editor').render()
  })

}
