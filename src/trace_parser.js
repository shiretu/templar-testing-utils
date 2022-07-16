
const fs = require('fs')
const { promisify } = require('util')
const readFile = promisify(fs.readFile)
const crypto = require('crypto')
const cliProgress = require('cli-progress')
const util = require('util')

const loadFile = async (filePath) => {
    console.log(`loading file ${filePath}`)
    const progress = new cliProgress.SingleBar({ }, cliProgress.Presets.shades_classic)
    const data = await readFile(filePath)
    let cursor = 0

    const ticksPerSecond = data.readBigUInt64LE(cursor)
    cursor += 8

    const pointsBytesCount = data.readBigUInt64LE(cursor)
    const pointsCount = pointsBytesCount / BigInt(16)
    cursor += 8
    const result = []
    progress.start(Number(pointsCount), 0)
    for (let i = 0; i < pointsCount; i++) {
        result.push({ time: data.readBigInt64LE(cursor), address: data.readBigInt64LE(cursor + 8) })
        cursor += 16
        if ((i % 100) === 0) { progress.update(i) }
    }
    progress.update(Number(pointsCount))
    progress.stop()

    const translation = {}

    while (cursor < data.byteLength) {
        const address = data.readBigUInt64LE(cursor)
        const length = data.readUint32LE(cursor + 8)
        const name = data.subarray(cursor + 12, cursor + 12 + length).toString()
        translation[`${address}`] = name
        cursor += 12 + length
    }

    return { ticksPerSecond, points: result.map(e => { return { name: translation[e.address], time: e.time } }) }
}

const loadFiles = async (pathBase) => {
    let points = []
    let i = 0
    let ticksPerSecond
    while (true) {
        const path = `${pathBase}_${i++}`
        if (!fs.existsSync(path)) break
        const data = await loadFile(path)
        points = points.concat(data.points)
        ticksPerSecond = data.ticksPerSecond
    }
    return { ticksPerSecond, points }
}

const getStacks = async (pathBase) => {
    // load all points
    const data = await loadFiles(pathBase)
    const points = data.points
    const ticksPerSecond = data.ticksPerSecond
    const startName = points[0].name

    // split all points into stacks
    const stacks = []
    let stack = { frames: [], hash: crypto.createHash('sha256') }
    console.log('Processing data points')
    const progress = new cliProgress.SingleBar({ }, cliProgress.Presets.shades_classic)
    progress.start(points.length, 0)
    const baseTime = points[0].time
    points.forEach((point, idx) => {
        point.time -= baseTime
        if ((idx % 100) === 0) { progress.update(idx) }
        if (point.name === startName) {
            if (stack.frames.length) {
                const last = stack.frames[stack.frames.length - 1]
                last.duration = point.time - last.time
                stack.duration = stack.frames.reduce((a, c) => { return a + c.duration }, BigInt(0))
                stack.hash = stack.hash.digest('hex')
                stacks.push(stack)
            }
            stack = { frames: [], hash: crypto.createHash('sha256') }
        }
        stack.frames.push(point)
        stack.hash.update(point.name)
        if (stack.frames.length >= 2) {
            const beforeLast = stack.frames[stack.frames.length - 2]
            const last = stack.frames[stack.frames.length - 1]
            beforeLast.duration = last.time - beforeLast.time
        }
    })
    progress.update(points.length)
    progress.stop()

    // get the unique collection of stacks
    const uniqueStacks = { all: [] }
    stacks.forEach(stack => {
        if (uniqueStacks[stack.hash]) return
        uniqueStacks[stack.hash] = 1
        uniqueStacks.all.push(stack)
    })

    return { ticksPerSecond, stacks, uniqueStacks: uniqueStacks.all }
}

const work = async () => {
    const data = await getStacks('/tmp/trace')
    const stacks = data.stacks
    const ticksPerSecond = Number(data.ticksPerSecond) / 1000000

    stacks.sort((a, b) => Number(b.duration - a.duration))
    console.log(`we have ${stacks.length} stack instances`)
    for (let i = 0; i < 30; i++) {
        console.log(util.inspect(stacks[i], false, null, true /* enable colors */))
    }
}

work()
