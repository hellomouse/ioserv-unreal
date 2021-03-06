let tty = {};
const pty = require('node-pty');
const prefix = "#tty-";
const K1 = String.fromCharCode(0x3);
const K2 = K1 + ",";
const ESCAPE_REGEX = /\x0f(.+?)\x0f/g;
const con2irc = {
    0: String.fromCharCode(0xF),
    4: String.fromCharCode(0x1F),
    7: K1 + "00,01",
    // 8: K + 35,
    30: K1 + "01",
    31: K1 + "04",
    32: K1 + "03",
    33: K1 + "08",
    34: K1 + "02",
    35: K1 + "13",
    36: K1 + "02",
    37: K1 + "00",
    40: K2 + "01",
    41: K2 + "04",
    42: K2 + "03",
    43: K2 + "08",
    44: K2 + "02",
    45: K2 + "06",
    46: K2 + "10",
    47: K2 + "00"
    
};
/*
function _parseData(data,tty) {
    tty.cursor[1] = 1;
    let offset = 0;
    const def = m => {
        offset -= m.length;
        return "";
    };
    data = data.replace(/\u001b\[([0-9;]+?)m/g, (m,p,o,s) => {
        //console.log(m,p,o);
        offset -= m.length;
        tty.color = "";
        return p.split(";").map(s => {
            tty.color += con2irc[parseInt(s,10)] || "";
            return tty.color;
        }).join("");
    });
    data = data.replace(/\u001b\[K/g,def);
    data = data.replace(/\u001b\c/g, (m,p,o,s) => {  // WIPE
        offset -= m.length;
        tty.cursor = [1,1];
        tty.color = "";
        return "\n".repeat(50);
    });
    data = data.replace(/\u001b\[J/g, m => {
        offset -= m.length;
        return "\n".repeat(50);
    });
    data = data.replace(/\u001b\[?([0-9;]+?)l/g, def);
    data = data.replace(/\u001b\[?([0-9;]+?)c/g, def);
    data = data.replace(/\u001b\[?([0-9;]*?)X/g, def);
    data = data.replace(/\u001b\[?([0-9;]*?)H/g, (m,p,o,s) => {
        offset -= m.length;
        let out = "";
        if(!p) {
            tty.cursor = [1,1];
            return out;
        } // HOME
        let y = p.split(";")[0];
        let x = p.split(";")[1];
        // if(o - offset > 0) x += o + offset;
        if(x > tty.cols) x = tty.cols;
        let xo = x-(o+offset);
        if(xo < 0) xo = 0;
        if(x - tty.cursor[1] > 0) out += ".".repeat(xo);
        if(y - tty.cursor[0] > 0) {
            let ld = data.length+offset;
            if (tty.cols - ld < 0) ld = tty.cols;
            out += ".".repeat(tty.cols-ld)+("\n"+tty.color).repeat(y-tty.cursor[0]);
            offset = 0;
        }
        offset = x;
        console.log(`Moving cursor from ${tty.cursor} to ${[y,x]}`);
        tty.cursor = [y, x];
        return out;
    });
    data = data.replace(/\u001b\[?([0-9;]+?)G/g, def);
    data = data.replace(/\u001b\[?([0-9;]+?)J/g, def);
    tty.cursor[0]++;
    tty.cursor[1] += 0;
    data = tty.color + data;
    return data;
}
*/
const VALID = [..."mpiJKgHMDrusfDCBAdhlcG"];
function parseData (data, tty) {
    data = [...data]; // rich man's .split("")
    for(let chari = 0; chari < data.length; chari++) {
        let char = data[chari];
        switch (char) {
            case "\n":
                if ( tty.cursor[0] == 29 ) {
                    for(let row = 0; row < 29; row++) {
                        tty.term[row] = Array.from(tty.term[row+1]);
                    }
                    tty.term[29] = Array(100).fill(" ");
                } else tty.cursor[0]++;
                tty.term[tty.cursor[0]][0] = tty.color;
                tty.cursor[1] = 1;
                break;
            case "\r":
                break;
            case "\u000e": // Font changer: FUCK YOU
                chari++;
            case "\u001b":
                // tty.bot.sendMsg("#logs", "Escape: "+data[chari+1]+data[chari+2]+data[chari+3]+data[chari+4]+data[chari+5]+data[chari+6]+data[chari+7]);
                if(data[++chari] == "c") {
                    tty.term = Array(30).fill(0);
                    for(let i in tty.term) {
                        tty.term[i] = Array(100).fill(" ");
                    }
                    tty.term[0][0] = "";
                }
                if(data[chari] == "(") {
                    chari++;
                }
                if(data[chari] == ")") {
                    chari++;
                }
                if(data[chari] == "[") {
                    let i = 0;
                    let done = false;
                    while(!done && ++i < 16) {
                        done = done || VALID.map(v => v == data[chari + i]).reduce((a, b) => a || b);
                    }
                    if(!done) break;
                    let esc = data.join("").substring(chari - 1, chari + i + 1);
                    if(data[chari + i] == "m") {
                        tty.term[tty.cursor[0]][tty.cursor[1]++] =  esc.replace(/\u001b\[([0-9;]*?)m/g, (m,p,o,s) => {
                            tty.color = "";
                            return p.split(";").map(s => {
                                tty.color += con2irc[parseInt(s,10)] || "";
                                return tty.color;
                            }).join("");
                        });
                    } else if(data[chari + i] == "H" || data[chari + i] == "H") {
                        esc.replace(/\u001b\[([0-9;]*?)[Hf]/g, (m,p,o,s) => {
                            let x = parseInt(p.split(";")[1],10);
                            let y = parseInt(p.split(";")[0],10) - 1;
                            tty.bot.sendMsg("#logs", x+";"+y+"|"+p);
                            if(!(y || x)) {
                                tty.cursor = [0, 1];
                                return;
                            }
                            tty.cursor[0] = y % 30 || tty.cursor[0];
                            tty.cursor[1] = x % 100 ||tty.cursor[1];
                        });
                    } else if(data[chari + i] == "K") {
                        esc.replace(/\u001b\[([0-9]*?)K/g, (m,p,o,s) => {
                            if(p == "") {
                                for(let i = tty.cursor[1]; i < 100; i++) {
                                    tty.term[tty.cursor[0]][i] = " ";
                                }
                            }
                            if(p == "1") {
                                for(let i = tty.cursor[1]; i >= 0; i--) {
                                    tty.term[tty.cursor[0]][i] = " ";
                                }
                            }
                            if(p == "2") {
                                tty.term[tty.cursor[0]] = Array(100).fill(" ");
                                tty.term[tty.cursor[0]][0] = tty.color;
                            }
                        });
                    } else if(data[chari + i] == "J") {
                        esc.replace(/\u001b\[([0-9]*?)J/g, (m,p,o,s) => {
                            if(p == "") {
                                for(let i = tty.cursor[0]; i < 30; i++) {
                                    tty.term[i] = Array(100).fill(" ");
                                    tty.term[i][0] = tty.color;
                                }
                            }
                            if(p == "1") {
                                for(let i = tty.cursor[0]; i >= 0; i--) {
                                    tty.term[i] = Array(100).fill(" ");
                                    tty.term[i][0] = tty.color;
                                }
                            }
                            if(p == "2") {
                                for(let i = 0; i < 30; i++)
                                tty.term[i] = Array(100).fill(" ");
                                tty.term[i][0] = tty.color;
                            }
                        });
                    } else if(data[chari + i] == "h") {
                        esc.replace(/\u001b\[\?([0-9]*?)h/g, (m,p,o,s) => {
                            if(p == "47" || parseInt(p,10) > 1000) tty.oterm = Array.from(tty.term);
                        });
                    } else if(data[chari + i] == "l") {
                        esc.replace(/\u001b\[\?([0-9]*?)l/g, (m,p,o,s) => {
                            if(p == "47" || parseInt(p,10) > 1000) tty.term = Array.from(tty.oterm);
                        });
                    } else {
                        tty.bot.sendMsg("#logs", "Unknown escape :"+[data[chari + i], esc].join(" | "));
                    }
                    chari += i;
                }
                break;
            default:
                if(tty.cursor[1] == 99) {
                    if ( tty.cursor[0] == 29 ) {
                        for(let row = 0; row < 29; row++) {
                            console.log(row, tty.term[row], tty.term[row+1]);
                            tty.term[row] = Array.from(tty.term[row+1]);
                        }
                        tty.term[29] = Array(100).fill(" ");
                        tty.term[29][0] = tty.color;
                    } else tty.cursor[0]++;
                    tty.term[tty.cursor[0]][0] = tty.color;
                    tty.cursor[1] = 1;
                }
                tty.term[tty.cursor[0]][tty.cursor[1]++] = char;
        }
    }


    return "\n".repeat(30) + "=".repeat(104) + "\n" + tty.term.map((row, i) => {
        if (i > 29) return;
        if(!row) row = Array(30).fill("");
        try { row.join("") } catch(e) { console.log(row,i,e.name); }
        return "| " + row.join("").padEnd(100 +( row.join("").match(/[\u000f\u001b\u0002\u001f]|\u0003(\d{1,2})?(,\d{1,2})?/g)||[""]).join("").length , " ") + " |";
    }).join("\n") + "\n" + "=".repeat(104);
}
function parseInput(input, tty) {
    //let pid = tty.pid;
    //* rewrite in process
    let nnl = false;
    input = input.replace(ESCAPE_REGEX, (match, command) => {
        if (command[0] === '^' && /[A-Z]/.test(command[1])) {
            return String.fromCharCode(command[1].charCodeAt(0) - 64);
        }
        let c = command.split(' ');
        switch (c[0]) {
            case 'EXIT':
                tty.destroy();
                return '';
            case 'ESC':
                return String.fromCharCode(27);
            case 'OUT':
                tty.out = c[1] !== 'OFF';
                return '';
            case "NNL": // No New Line
                return;
            default:
                return '';
        }
    });
    if (nnl) input = input.replace(/[\r\n]*?/g,"");
    return input;
}
module.exports = function(bot) {
    bot.ttyid = bot.ttyid || 1;
    bot.addCmd('starttty', 'tty', event => {
        let id = bot.ttyid++;
        let chan = prefix + id;
        chan = event.args[0] || chan;
        bot.join(bot.config.bname, chan, true);
        bot.mode(chan, '+ns-i');
        //bot.send(`:${bot.config.bname} INVITE ${event.rhost.uid} ${chan} 0`);
        tty[id] = pty.spawn('bash', [], {
          name: 'linux',
          cols: 80,
          rows: 30,
          cwd: process.env.HOME,
          env: process.env
        });
        tty[id].bot = bot;
        tty[id].out = true;
        tty[id].chan = chan;
        tty[id].cursor = [0, 1];
        tty[id].color = "";
        tty[id].term = Array(30).fill(0);
        for(let i in tty[id].term) {
            tty[id].term[i] = Array(100).fill(" ");
        }
        tty[id].term[0][0] = "";
        tty[id].oterm = Array.from(tty[id].term);
        tty[id].on('data', function(data) {
           let out = parseData(data, tty[id]);
           if(tty[id].out) bot.sendMsg(chan, out);
        });
        tty[id].on('close', () => {
            bot.sendMsg(chan, '[Session ended]');
            bot.part(bot.config.bname, chan, 'Session ended');
        });
        bot.privmsg.on(chan, event => {
            if (event.uperms < 11) return;
            tty[id].li = event.args.join(" ");
            let str = parseInput(event.args.join(" "),tty[id]);
            if (!str.length) return;
            tty[id].write(str+"\r");
        });
        event.sendBack(`Join ${chan} and enjoy your tty (PID=${tty[id].pid})`);
    }, "Starts an interactive terminal session", 11);
    bot.addCmd("redraw", "tty", event => {
        let id = parseInt(event.args[0],10);
        //tty[id].redraw();
        parseData("", tty[id]);
    }, "Redraw a terminal.", 11);
    bot.servmsg.on('JOIN', (head, msg, uid) => {
        if (head[2].toLowerCase().startsWith(prefix)) {
            if ((bot.config.uperms[bot.getUser(uid).account] || 0) < 11) {
                bot.skick(head[2], uid, 'Unauthorized');
            } else if (!tty[head[2].slice(prefix.length)]) {
                bot.skick(head[2], uid, 'Resetting TTYs...');
            }
        }
    });
    bot.servmsg.on("SJOIN", (head,msg,serv) => {
        if (head[2].toLowerCase().startsWith(prefix)) {
            bot.join(bot.config.bname, head[2]);
            let id = head[2].slice(prefix.length);
            setTimeout(() => {
                if (!tty[id]) bot.part(bot.config.bname, head[2]);
            }, 60000);
            bot.mode(head[2], '+nsi');
            let lusers = msg.map(a=>a.replace("@","").replace("+",""));
            for (let i = 0; i < lusers.length; i++) {
return;
                if ((bot.config.uperms[bot.getUser(lusers[i]).account] || 0) < 11) {
                    bot.skick(head[2], lusers[i], 'Unauthorized');
                } else if (!tty[head[2].slice(prefix.length)]) {
                    bot.skick(head[2], lusers[i], 'Resetting TTYs...');
                }
            }
        }
    });
    return tty;
}
