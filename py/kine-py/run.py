# kine-py 入口：python run.py（stdio JSON 协议）
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kine_py.server import main

if __name__ == '__main__':
    main()
